#!/usr/bin/env node
/**
 * relabel-dry-run.mjs — 历史重打的**只读演练**：只输出"如果重打，会改哪些字段"。
 *
 * 不写 bc-index.jsonl、不写 baseline、不写 raw。想真正写盘必须另有写盘脚本，且先备份。
 *
 * 用法：
 *   node bin/relabel-dry-run.mjs --index <bc-index.jsonl> --raw <session.v4.jsonl.zstd>
 *     [--concepts <concepts.md>] [--baseline-file <file>]
 *     [--center-min 0.02] [--lead 0.02] [--limit 500] [--json]
 *
 * 选项：
 *   --index <file>         必填，bc-index.jsonl
 *   --raw <file>           必填，raw 会话（.jsonl 或 .jsonl.zstd，帧式也支持）
 *   --concepts <file>      A 表（默认 <pkg>/templates/concepts.md）
 *   --baseline-file <file> 显式 baseline（{topic:mean} 或 {version,window,samples}）。
 *                          不给则用"被对齐上的那些轮的 leave-one-out 均值"——**只用于演练，
 *                          绝不能当生产 baseline**；输出里会标明来源。
 *   --center-min / --lead / --topic-min-score / --min-score / --chunk-chars / --max-chunks
 *   --limit <n>            只看前 n 条 diff（默认 60）
 *   --json                 只输出 JSON
 *
 * 对齐规则：只用 turn 对齐 index 与 raw；raw 里找不到该轮文本 → 记 unresolved，不猜。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = argv[i + 1];
  return next === undefined || next.startsWith('--') ? true : next;
};
const num = (name, fallback) => {
  const v = opt(name);
  if (v === null || v === true) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const indexFile = opt('index');
const rawFile = opt('raw');
if (!indexFile || indexFile === true || !rawFile || rawFile === true) {
  console.error('用法：node bin/relabel-dry-run.mjs --index <bc-index.jsonl> --raw <session.jsonl[.zstd]>');
  process.exit(2);
}

const conceptsPath = (() => {
  const explicit = opt('concepts');
  if (explicit && explicit !== true) return explicit;
  const candidate = path.join(pkgRoot, 'templates', 'concepts.md');
  return fs.existsSync(candidate) ? candidate : null;
})();
if (!conceptsPath || !fs.existsSync(conceptsPath)) {
  console.error('找不到 A 表：请用 --concepts 指定');
  process.exit(2);
}

const centerMin = num('center-min', 0.02);
const lead = num('lead', 0.02);
const topicMinScore = num('topic-min-score', 0.33);
const minScore = num('min-score', 0.25);
const chunkChars = num('chunk-chars', 600);
const maxChunks = num('max-chunks', 12);
const limit = num('limit', 60);
const asJson = Boolean(opt('json', false));
const baselineFile = opt('baseline-file');

const { createBLabeler } = await import('file://' + path.join(pkgRoot, 'src/memory/bc-label.mjs'));
const { loadConcepts } = await import('file://' + path.join(pkgRoot, 'src/memory/concepts-file.mjs'));
const { embedTexts } = await import('file://' + path.join(pkgRoot, 'src/facets/embedding.mjs'));
const { eventText } = await import('file://' + path.join(pkgRoot, 'src/session-log.mjs'));

const INJECTED = /^\[(?:抽取|工作线|标签|规则|习惯|技能|归位|候选|存\?|闸|回正|学习|追忆|记忆|continuity:[a-z-]+)\]/;
const MACHINE = /^(?:Current runtime context|Current working directory|Current DSH file policy|Approval prompts|Time sampled)/;

const conceptRows = loadConcepts(conceptsPath);
const labels = Object.fromEntries(conceptRows.map((r) => [r.label, r.description]));
const kinds = Object.fromEntries(conceptRows.map((r) => [r.label, r.kind]));
const concepts = conceptRows.map((r) => r.label);
const topics = conceptRows.filter((r) => r.kind === 'topic').map((r) => r.label);

// ---------- raw 读取：支持纯 jsonl 与"一串 zstd 帧" ----------
function readRawLines(file) {
  const lines = [];
  if (/\.zstd$/i.test(file)) {
    const buf = fs.readFileSync(file);
    const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
    const starts = [];
    for (let i = 0; ; ) {
      const k = buf.indexOf(MAGIC, i);
      if (k < 0) break;
      starts.push(k);
      i = k + 4;
    }
    for (const start of starts) {
      let out;
      try { out = zlib.zstdDecompressSync(buf.subarray(start)); } catch { continue; }
      for (const line of out.toString('utf8').split(/\r?\n/)) if (line) lines.push(line);
    }
    return lines;
  }
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
}

const rawLines = readRawLines(rawFile);
const events = [];
const seenSeq = new Set();
for (const line of rawLines) {
  let event;
  try { event = JSON.parse(line.replace(/^\uFEFF/, '')); } catch { continue; }
  const seq = Number(event?.seq);
  if (Number.isInteger(seq)) {
    if (seenSeq.has(seq)) continue;
    seenSeq.add(seq);
  }
  events.push(event);
}
events.sort((a, b) => Number(a.seq) - Number(b.seq));

// ---------- 与 updater 相同的 turnsFromEvents ----------
const markers = events
  .map((event) => ({ seq: Number(event?.seq), turn: Number(event?.data?.turn) }))
  .filter((item) => Number.isInteger(item.seq) && Number.isInteger(item.turn))
  .sort((a, b) => a.seq - b.seq);
const turnAt = (seq) => {
  let found = null;
  for (const marker of markers) {
    if (marker.seq > seq) break;
    found = marker.turn;
  }
  if (found !== null) return found;
  return markers.find((marker) => marker.seq >= seq)?.turn ?? null;
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

// ---------- index 读取 ----------
const indexRows = fs.readFileSync(indexFile, 'utf8')
  .replace(/^\uFEFF/, '')
  .split(/\r?\n/)
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line));

const labeler = createBLabeler({ embed: embedTexts, labels, concepts, kinds });

const topicOfRecord = (record) => {
  if (Array.isArray(record.genericTopic) && record.genericTopic.length > 0) return record.genericTopic[0];
  const generic = Array.isArray(record.generic) ? record.generic : [];
  return generic.find((name) => kinds[name] === 'topic') ?? null;
};
const workflowsOfRecord = (record) => {
  if (Array.isArray(record.genericWorkflow)) return record.genericWorkflow;
  const generic = Array.isArray(record.generic) ? record.generic : [];
  return generic.filter((name) => kinds[name] === 'workflow');
};
const scoreOfRecord = (record, concept) => {
  const scores = record.conceptScores ?? {};
  const value = Number(scores[concept]);
  return Number.isFinite(value) ? value : null;
};

// ---------- baseline ----------
let explicitBaseline = null;
let baselineSource = 'leave-one-out(演练用)';
if (baselineFile && baselineFile !== true) {
  const raw = JSON.parse(fs.readFileSync(baselineFile, 'utf8').replace(/^\uFEFF/, ''));
  const source = raw?.samples && typeof raw.samples === 'object' ? raw.samples : raw;
  explicitBaseline = Object.fromEntries(topics.map((t) => {
    const value = source?.[t];
    if (Array.isArray(value)) {
      const nums = value.map((x) => Number(x)).filter((x) => Number.isFinite(x));
      return [t, nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : Number.NaN];
    }
    if (value === undefined || value === null || value === '') return [t, Number.NaN];
    const n = Number(value);
    return [t, Number.isFinite(n) ? n : Number.NaN];
  }));
  const known = Object.values(explicitBaseline).filter((v) => Number.isFinite(v));
  if (known.length > 0) {
    const fallback = known.reduce((a, b) => a + b, 0) / known.length;
    for (const t of topics) if (!Number.isFinite(explicitBaseline[t])) explicitBaseline[t] = fallback;
  } else {
    explicitBaseline = null;
    baselineSource = 'raw-bootstrap(文件无样本)';
  }
  if (explicitBaseline) baselineSource = `file:${baselineFile}`;
}

// ---------- 逐轮重打（只读） ----------
const evaluated = [];
for (const record of indexRows) {
  const turn = Number(record.turn);
  if (!Number.isInteger(turn)) continue;
  const entry = turns.get(turn);
  if (!entry) {
    evaluated.push({ record, turn, unresolved: true });
    continue;
  }
  const text = [...entry.userTexts, ...entry.assistantTexts].join('\n');
  evaluated.push({ record, turn, text, unresolved: false });
}

// leave-one-out baseline 需要用每轮 raw 分；没给文件时先粗算一遍
let looBaseline = null;
if (!explicitBaseline) {
  const sums = Object.fromEntries(topics.map((t) => [t, 0]));
  let count = 0;
  for (const item of evaluated) {
    if (item.unresolved) continue;
    const res = await labeler.labelChunked(item.text, {
      topK: 3, minScore, topicMinScore, topicCenterMin: -Infinity, topicLead: -Infinity,
      chunkChars, maxChunks, topicTopK: 1,
    });
    const scores = res.topicScores ?? {};
    const keys = topics.filter((t) => Number.isFinite(Number(scores[t])));
    if (keys.length === 0) continue;
    for (const t of keys) sums[t] += Number(scores[t]);
    count += 1;
  }
  if (count > 0) {
    looBaseline = Object.fromEntries(topics.map((t) => [t, sums[t] / count]));
    baselineSource = `leave-one-out(演练用,${count} 轮)`;
  } else {
    baselineSource = 'raw-bootstrap(无可用轮次)';
  }
}

const diffs = [];
const summary = {
  indexRows: indexRows.length,
  evaluated: 0,
  unresolved: 0,
  changed: 0,
  unchanged: 0,
  emptyToTopic: 0,
  topicToEmpty: 0,
  topicChanged: 0,
  workflowChanged: 0,
  scoreChanged: 0,
  baselineSource,
};

for (const item of evaluated) {
  if (item.unresolved) { summary.unresolved += 1; continue; }
  summary.evaluated += 1;

  let baseline = explicitBaseline ?? looBaseline;
  if (!explicitBaseline && looBaseline) {
    // 近似 leave-one-out：把本轮 raw 分从均值里扣掉（用粗算的那一轮分不够精确，宁可标来源）
    baseline = looBaseline;
  }

  const res = await labeler.labelChunked(item.text, {
    topK: 3,
    minScore,
    topicMinScore,
    topicCenterMin: centerMin,
    topicLead: lead,
    chunkChars,
    maxChunks,
    topicTopK: 1,
    topicBaseline: baseline ?? undefined,
  });

  const oldTopic = topicOfRecord(item.record);
  const oldWorkflows = workflowsOfRecord(item.record);
  const oldScore = oldTopic ? scoreOfRecord(item.record, oldTopic) : null;
  const oldConfidence = Number.isFinite(Number(item.record.topicConfidence)) ? Number(item.record.topicConfidence) : null;

  const newTopic = (res.topic ?? [])[0]?.concept ?? null;
  const newWorkflows = (res.workflow ?? []).map((w) => w.concept);
  const newScore = newTopic ? Number(res.topicScores?.[newTopic] ?? res.topic?.[0]?.score ?? 0) : null;
  const newConfidence = newTopic ? Number(res.topicConfidence ?? 0) : null;

  const changedTopic = (oldTopic ?? null) !== (newTopic ?? null);
  const changedWorkflow = oldWorkflows.join('|') !== newWorkflows.join('|');
  const changedScore = oldScore !== null && newScore !== null && Math.abs(oldScore - newScore) > 1e-6;
  const changed = changedTopic || changedWorkflow || changedScore || (oldConfidence ?? null) !== (newConfidence ?? null);

  if (changed) summary.changed += 1; else summary.unchanged += 1;
  if (!oldTopic && newTopic) summary.emptyToTopic += 1;
  if (oldTopic && !newTopic) summary.topicToEmpty += 1;
  if (oldTopic && newTopic && oldTopic !== newTopic) summary.topicChanged += 1;
  if (changedWorkflow) summary.workflowChanged += 1;
  if (changedScore) summary.scoreChanged += 1;

  diffs.push({
    turn: item.turn,
    oldTopic,
    newTopic,
    oldWorkflows,
    newWorkflows,
    oldTopicScore: oldScore,
    newTopicScore: newScore,
    oldConfidence,
    newConfidence,
    changed,
  });
}

const payload = {
  summary,
  diffs,
  note: explicitBaseline
    ? 'baseline 来自文件；本脚本只读，未写任何文件'
    : 'baseline 由被对齐轮次自身算出（leave-one-out 近似），仅用于演练，不可当生产 baseline；本脚本只读',
};

const looRounds = Number((summary.baselineSource.match(/leave-one-out\(演练用,(\d+) 轮\)/) ?? [])[1] ?? 0);
const lowSample = !explicitBaseline && looRounds > 0 && looRounds < 100;
if (lowSample) {
  payload.warning = `baseline 仅 ${looRounds} 轮（<100），结果仅供参考，不能当生产结论`;
}

if (asJson) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log(`  index ${summary.indexRows} 行 · 可重打 ${summary.evaluated} · unresolved ${summary.unresolved}`);
  console.log(`  A 表 ${conceptRows.length} 条（topic ${topics.length}）· 判据 centered≥${centerMin} lead≥${lead} · baseline ${summary.baselineSource}`);
  if (lowSample) console.log(`  ⚠ ${payload.warning}`);
  console.log(`  变更 ${summary.changed} · 不变 ${summary.unchanged} · 空→topic ${summary.emptyToTopic} · topic→空 ${summary.topicToEmpty}`);
  console.log(`  换 topic ${summary.topicChanged} · 换 workflow ${summary.workflowChanged} · 分数变化 ${summary.scoreChanged}`);
  console.log('');
  const shown = diffs.filter((d) => d.changed).slice(0, limit);
  if (shown.length === 0) {
    console.log('  没有会变更的行。');
  } else {
    console.log('  turn  oldTopic → newTopic                          score         wf');
    for (const d of shown) {
      const score = `${d.oldTopicScore === null ? '-' : d.oldTopicScore.toFixed(3)}→${d.newTopicScore === null ? '-' : d.newTopicScore.toFixed(3)}`;
      console.log(`  ${String(d.turn).padStart(5)}  ${String(d.oldTopic ?? '(空)').padEnd(12)} → ${String(d.newTopic ?? '(空)').padEnd(14)} ${score.padEnd(13)} ${d.oldWorkflows.join('/') || '-'} → ${d.newWorkflows.join('/') || '-'}`);
    }
    if (diffs.filter((d) => d.changed).length > shown.length) {
      console.log(`  … 还有 ${diffs.filter((d) => d.changed).length - shown.length} 条，用 --limit 或 --json 看全`);
    }
  }
}
