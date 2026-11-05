/**
 * relabel-migrate.mjs — 历史重打（**只改 topic 四字段**）的进程内启动迁移。
 *
 * 为什么要在进程内做：bc-index-updater 写盘是整文件重写，`records` 是启动时读进内存的。
 * 外部替换文件后只要再跑一轮对话，就会被内存里的旧标签整文件覆盖。
 *
 * 触发方式（显式 opt-in，升级本身绝不自动打 marker）：
 *   在 session 目录放 `bc-index.relabel-pending.json`：
 *     { "fields": ["topic"], "baseline": "self-loo", "conceptsHash": "<concepts.md 的 sha256>" }
 *   conceptsHash 不符 → abort（保留 marker），避免拿旧表重标。
 *
 * 行为：
 *   1. 读 raw、按 updater 同规则重建每轮 text
 *   2. 一轮打标拿到所有 topic 的 raw 分 → 算 self-loo 均值（本 session 自己）
 *   3. 用 centered≥centerMin 且 lead≥lead 判 topic（与 4.11.23+ labeler 同口径）
 *   4. 只改 genericTopic / topicScore / topicConfidence / topicMinScore
 *   5. 备份 index → 写 tmp → 校验（行数、非目标字段深度相等）→ rename → 删 marker
 *   6. 出错：保留 marker 与原始 index，把错误抛给调用方（启动可继续，不阻塞服务）
 *
 * 不做的事：
 *   · 不改 workflow（等 workflow baseline 成熟）
 *   · 不改 raw
 *   · 不自动创建 marker
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const INJECTED = /^\[(?:抽取|工作线|标签|规则|习惯|技能|归位|候选|存\?|闸|回正|学习|追忆|记忆|continuity:[a-z-]+)\]/;
const MACHINE = /^(?:Current runtime context|Current working directory|Current DSH file policy|Approval prompts|Time sampled)/;

const TOPIC_FIELDS = ['genericTopic', 'topicScore', 'topicConfidence', 'topicMinScore'];
// labelStamp 是第五个"允许变更"的元字段：迁移把它写成当前依据的戳，
// 否则第一次迁移会被自己的"非目标字段零改动"校验 abort（创 2026-11-04 指出）。
const STAMP_FIELD = 'labelStamp';
const ALLOWED_FIELDS = [...TOPIC_FIELDS, STAMP_FIELD];

export function conceptsHash(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function readMarker(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function readRawLines(file) {
  if (!/\.zstd$/i.test(file)) {
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  }
  const buf = fs.readFileSync(file);
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const starts = [];
  for (let i = 0; ; ) {
    const k = buf.indexOf(MAGIC, i);
    if (k < 0) break;
    starts.push(k);
    i = k + 4;
  }
  const lines = [];
  for (const start of starts) {
    let out;
    try { out = zlib.zstdDecompressSync(buf.subarray(start)); } catch { continue; }
    for (const line of out.toString('utf8').split(/\r?\n/)) if (line) lines.push(line);
  }
  return lines;
}

function turnsFromEvents(events, eventText) {
  const markers = events
    .map((event) => ({ seq: Number(event?.seq), turn: Number(event?.data?.turn) }))
    .filter((m) => Number.isInteger(m.seq) && Number.isInteger(m.turn))
    .sort((a, b) => a.seq - b.seq);
  const turnAt = (seq) => {
    let found = null;
    for (const marker of markers) { if (marker.seq > seq) break; found = marker.turn; }
    return found ?? markers.find((m) => m.seq >= seq)?.turn ?? null;
  };
  const isHuman = (event) => {
    const source = event?.data?.source ?? event?.source;
    if (source && typeof source.kind === 'string' && source.kind !== 'user') return false;
    if (source && source.peer === true) return false;
    const text = eventText(event, { includeReasoning: false }).trim();
    return Boolean(text) && !INJECTED.test(text) && !MACHINE.test(text);
  };
  const turns = new Map();
  for (const event of events) {
    const type = event?.type;
    if (type !== 'user/message' && type !== 'assistant/message') continue;
    if (type === 'user/message' && !isHuman(event)) continue;
    const text = eventText(event, { includeReasoning: false }).trim();
    if (!text || INJECTED.test(text) || MACHINE.test(text)) continue;
    const seq = Number(event?.seq);
    const turn = Number.isInteger(Number(event?.data?.turn)) ? Number(event.data.turn) : turnAt(seq);
    if (!Number.isInteger(turn)) continue;
    const item = turns.get(turn) ?? { turn, userTexts: [], assistantTexts: [] };
    if (type === 'user/message') item.userTexts.push(text);
    else item.assistantTexts.push(text);
    turns.set(turn, item);
  }
  return turns;
}

/** 单轮判定：与 labeler 的 centered≥centerMin 且 lead≥lead 同口径。 */
export function decideTopic(scores, baseline, { topicMinScore = 0.33, centerMin = 0.02, lead = 0.02 } = {}) {
  const items = Object.entries(scores)
    .filter(([, raw]) => Number.isFinite(raw))
    .map(([concept, raw]) => ({ concept, raw, centered: raw - (Number.isFinite(baseline?.[concept]) ? baseline[concept] : 0) }))
    .sort((a, b) => b.centered - a.centered);
  const top = items[0];
  const second = items[1];
  if (!top) return null;
  if (top.raw < topicMinScore) return null;
  if (top.centered < centerMin) return null;
  if (second && top.centered - second.centered < lead) return null;
  return { concept: top.concept, raw: top.raw, centered: top.centered, confidence: confidenceOf(top.raw) };
}

function confidenceOf(score) {
  if (score >= 0.6) return 'strong';
  if (score >= 0.45) return 'normal';
  return 'weak';
}

/**
 * 执行一次迁移。返回 {status, ...}，不抛异常（除非调用方要求）。
 *
 * 事件来源二选一（in-process 与 CLI）：
 *   · events: async () => Event[]   —— 插件内用（宿主没有 raw 文件路径，只有 sessionQuery）
 *   · rawFile: string               —— CLI 用（本地会话文件）
 * 两者都没给 → abort 'no-event-source'。
 *
 * @param {object} opts
 * @param {string} opts.indexFile
 * @param {string} [opts.rawFile]
 * @param {() => Promise<object[]>} [opts.events]
 * @param {string} opts.conceptsFile
 * @param {string} opts.markerFile
 * @param {object} opts.labeler   createBLabeler(...) 的实例
 * @param {(event, options?) => string} opts.eventText  session-log 的 eventText
 * @param {Function} [opts.log]
 */
export async function runRelabelMigration({ indexFile, rawFile, events: eventsProvider, conceptsFile, markerFile, labeler, eventText, forceFull = false, log = () => {} }) {
  const marker = readMarker(markerFile);
  if (!marker) return { status: 'no-marker' };
  const fields = Array.isArray(marker.fields) ? marker.fields : [];
  if (!fields.includes('topic')) return { status: 'skip', reason: 'marker.fields 不含 topic' };
  if (marker.baseline !== 'self-loo') return { status: 'skip', reason: '只支持 baseline=self-loo' };
  const hasEventsProvider = typeof eventsProvider === 'function';
  const hasRawFile = Boolean(rawFile) && fs.existsSync(rawFile);
  if (!hasEventsProvider && !hasRawFile) {
    log('[relabel] abort：既没有 events provider，也没有可读的 rawFile');
    return { status: 'abort', reason: 'no-event-source' };
  }
  const hash = conceptsHash(conceptsFile);
  if (marker.conceptsHash && marker.conceptsHash !== hash) {
    log(`[relabel] abort：concepts.md 已变（marker ${marker.conceptsHash.slice(0, 12)} ≠ 当前 ${hash.slice(0, 12)}）`);
    return { status: 'abort', reason: 'concepts-hash-mismatch' };
  }
  // 阈值：marker 可覆盖，必须有限且在区间内；非法值回退默认并 warn
  const rawThresholds = marker.thresholds ?? {};
  const finiteIn = (value, min, max, fallback, name) => {
    const n = Number(value);
    if (value === undefined) return fallback;
    if (Number.isFinite(n) && n >= min && n <= max) return n;
    log(`[relabel] warn：marker.thresholds.${name}=${value} 非法，用默认 ${fallback}`);
    return fallback;
  };
  const thresholds = {
    topicMinScore: finiteIn(rawThresholds.topicMinScore, 0.2, 0.9, 0.33, 'topicMinScore'),
    centerMin: finiteIn(rawThresholds.centerMin, 0, 0.5, 0.02, 'centerMin'),
    lead: finiteIn(rawThresholds.lead, 0, 0.5, 0.02, 'lead'),
  };
  // labelStamp 的依据必须真实，但**不能**用包版本：
  // 发版（哪怕只改文档）会让 stamp 全员失效、触发一次全量重扫（创 2026-11-04 定）。
  // 来源顺序：marker.labelerVersion（仅回归覆盖）→ bc-label.mjs 的 LABELER_VERSION 常量。
  let labelerVersion = typeof marker.labelerVersion === 'string' ? marker.labelerVersion : null;
  if (!labelerVersion) {
    const { LABELER_VERSION } = await import('./bc-label.mjs');
    labelerVersion = Number.isFinite(Number(LABELER_VERSION)) ? String(LABELER_VERSION) : null;
  }
  if (!labelerVersion) {
    log('[relabel] abort：拿不到 labelerVersion（bc-label.mjs 未导出 LABELER_VERSION，marker 也没给）');
    return { status: 'abort', reason: 'no-labeler-version' };
  }
  const stamp = createHash('sha256')
    .update(`${hash}|${thresholds.topicMinScore}|${thresholds.centerMin}|${thresholds.lead}|${labelerVersion}`)
    .digest('hex')
    .slice(0, 12);

  const started = Date.now();
  log('[relabel] 开始：取事件');
  const rawEvents = hasEventsProvider
    ? await eventsProvider()
    : readRawLines(rawFile).map((line) => {
      try { return JSON.parse(line.replace(/^\uFEFF/, '')); } catch { return null; }
    }).filter(Boolean);
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
    log('[relabel] abort：事件为空');
    return { status: 'abort', reason: 'empty-events' };
  }
  const events = [];
  const seen = new Set();
  for (const event of rawEvents) {
    const seq = Number(event?.seq);
    if (Number.isInteger(seq)) { if (seen.has(seq)) continue; seen.add(seq); }
    events.push(event);
  }
  events.sort((a, b) => Number(a.seq) - Number(b.seq));
  const turns = turnsFromEvents(events, eventText);
  log(`[relabel] 事件 ${events.length} · 轮次 ${turns.size}`);

  const records = fs.readFileSync(indexFile, 'utf8').replace(/^\uFEFF/, '')
    .split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => JSON.parse(line));

  // 安全增量：只有“全表 stamp 都等于本次 stamp”才整体跳过。
  // 不做逐行跳过：self-LOO baseline 会因为少算 stale 行而偏，写盘会得到错误的 centered。
  if (!forceFull && records.length > 0 && records.every((record) => record.labelStamp === stamp)) {
    fs.unlinkSync(markerFile);
    log('[relabel] 跳过：所有行 labelStamp 已是当前值');
    return {
      status: 'done',
      noop: true,
      stats: { rows: records.length, relabelled: 0, unresolved: 0, topicChanged: 0, toEmpty: 0, fromEmpty: 0, same: records.length },
    };
  }

  // 覆盖前置检查：**先验证事件能不能覆盖 index 的全部 turn，再开始打标**。
  // 若宿主给的是有界快照，原来的流程会先白烧几秒到几分钟 CPU（风扇先转一下），
  // 打标完才发现大量行重建不出来。宁可在 0.1 秒内失败。
  const indexTurns = records
    .map((record) => Number(record.turn))
    .filter((turn) => Number.isInteger(turn));
  const missingTurns = indexTurns.filter((turn) => !turns.has(turn));
  if (missingTurns.length > 0) {
    log(`[relabel] abort：事件覆盖不足（事件 ${events.length} · 推出轮次 ${turns.size} · index ${indexTurns.length} 轮 · 缺 ${missingTurns.length} 轮）`);
    return {
      status: 'abort',
      reason: 'read-not-covering',
      events: events.length,
      turnsFromEvents: turns.size,
      indexTurns: indexTurns.length,
      missing: missingTurns.length,
      missingSample: missingTurns.slice(0, 10),
    };
  }

  // 第一遍：每个可重打轮次拿全部 topic 的 raw 分（居中/领先都不设限，只取分）
  const scored = new Map();
  let done = 0;
  const topicsSeen = new Set();
  for (const record of records) {
    const turn = Number(record.turn);
    const entry = Number.isInteger(turn) ? turns.get(turn) : null;
    if (!entry) continue;
    const text = [...entry.userTexts, ...entry.assistantTexts].join('\n');
    const res = await labeler.labelChunked(text, {
      topK: 24, minScore: 0.25, topicMinScore: -Infinity, topicCenterMin: -Infinity, topicLead: -Infinity, topicTopK: 24,
    });
    const scores = {};
    for (const item of res.topic ?? []) {
      if (Number.isFinite(item.score)) scores[item.concept] = item.score;
      topicsSeen.add(item.concept);
    }
    scored.set(turn, scores);
    done += 1;
    if (done % 200 === 0) log(`[relabel] 打标 ${done} 轮 · 已用 ${Math.round((Date.now() - started) / 1000)}s`);
  }
  if (scored.size === 0) {
    log('[relabel] abort：没有可重打的轮次');
    return { status: 'abort', reason: 'no-turns' };
  }

  // apply 是 all-or-nothing：只要有一行重建不出 text，就在写备份之前 abort。
  // 不能指望后面的字段校验兜底——旧行若已带同 stamp，字段校验会通过，
  // 结果就是"rename 成功 + 删 marker"，却留下未重标的行（创 2026-11-04 指出）。
  const unresolvedTurns = records
    .map((record) => Number(record.turn))
    .filter((turn) => !Number.isInteger(turn) || !scored.has(turn));
  if (unresolvedTurns.length > 0) {
    log(`[relabel] abort：${unresolvedTurns.length} 行无法重建 text（例如 turn ${unresolvedTurns.slice(0, 5).join(', ')}），未写任何文件`);
    return { status: 'abort', reason: 'unresolved-rows', unresolved: unresolvedTurns.slice(0, 20) };
  }

  // self-loo 均值：本 session 自己
  const sums = {};
  const counts = {};
  for (const scores of scored.values()) {
    for (const [concept, raw] of Object.entries(scores)) {
      sums[concept] = (sums[concept] ?? 0) + raw;
      counts[concept] = (counts[concept] ?? 0) + 1;
    }
  }
  const globalMean = Object.values(sums).reduce((a, b) => a + b, 0) / Math.max(1, Object.keys(sums).length);
  const looFor = (scores) => {
    const out = {};
    for (const [concept, mean] of Object.entries(sums)) {
      const own = scores[concept];
      const n = counts[concept] ?? 0;
      out[concept] = n > 1 && Number.isFinite(own) ? (mean - own) / (n - 1) : mean / Math.max(1, n);
    }
    // 缺失项用全局均值兜底（与生产 baseline 的 missing 回退同口径）
    return new Proxy(out, { get: (target, key) => (Number.isFinite(target[key]) ? target[key] : globalMean) });
  };

  // 第二遍：判定 + 改写（只四个字段）
  const updated = [];
  const stats = { rows: records.length, relabelled: 0, unresolved: 0, topicChanged: 0, toEmpty: 0, fromEmpty: 0, same: 0 };
  for (const record of records) {
    const turn = Number(record.turn);
    const scores = Number.isInteger(turn) ? scored.get(turn) : null;
    if (!scores) {
      stats.unresolved += 1;
      updated.push(JSON.stringify(record));
      continue;
    }
    const decision = decideTopic(scores, looFor(scores), thresholds);
    const oldTopic = Array.isArray(record.genericTopic) && record.genericTopic.length > 0 ? record.genericTopic[0] : null;
    const next = {};
    for (const [key, value] of Object.entries(record)) {
      if (TOPIC_FIELDS.includes(key) || key === STAMP_FIELD) continue;
      next[key] = value;
    }
    next.genericTopic = decision ? [decision.concept] : [];
    if (decision) {
      next.topicScore = Number(decision.raw.toFixed(6));
      next.topicConfidence = decision.confidence;
    }
    next.topicMinScore = thresholds.topicMinScore;
    next[STAMP_FIELD] = stamp;
    if (oldTopic !== (decision?.concept ?? null)) {
      stats.topicChanged += 1;
      if (oldTopic && !decision) stats.toEmpty += 1;
      if (!oldTopic && decision) stats.fromEmpty += 1;
    } else {
      stats.same += 1;
    }
    stats.relabelled += 1;
    updated.push(JSON.stringify(next));
  }

  // 备份 + 写 tmp + 校验 + rename
  const backup = `${indexFile}.bak-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  fs.copyFileSync(indexFile, backup);
  const tmp = `${indexFile}.relabel-tmp-${process.pid}`;
  fs.writeFileSync(tmp, updated.join('\n') + '\n', 'utf8');

  const after = fs.readFileSync(tmp, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  if (after.length !== records.length) {
    log(`[relabel] abort：行数不一致 ${records.length} → ${after.length}（原文件未动）`);
    return { status: 'abort', reason: 'length-mismatch' };
  }
  let touched = 0;
  for (let i = 0; i < records.length; i += 1) {
    for (const key of Object.keys(records[i])) {
      if (ALLOWED_FIELDS.includes(key)) continue;
      if (JSON.stringify(records[i][key]) !== JSON.stringify(after[i][key])) touched += 1;
    }
    // labelStamp 只允许写成"本次的戳"；写别的值等于改了依据，算越界
    if (after[i][STAMP_FIELD] !== stamp) touched += 1;
  }
  if (touched > 0) {
    log(`[relabel] abort：非目标字段被改动 ${touched} 处（原文件未动）`);
    return { status: 'abort', reason: 'field-mismatch' };
  }
  fs.renameSync(tmp, indexFile);
  fs.unlinkSync(markerFile);
  log(`[relabel] 完成：重打 ${stats.relabelled} · unresolved ${stats.unresolved} · 换 topic ${stats.topicChanged}（→空 ${stats.toEmpty} · 空→topic ${stats.fromEmpty}）· 不变 ${stats.same} · 备份 ${path.basename(backup)}`);
  return { status: 'done', stats, backup, elapsedMs: Date.now() - started, topics: topicsSeen.size };
}
