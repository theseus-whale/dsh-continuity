#!/usr/bin/env node
/**
 * relabel-apply.mjs — 历史重打（**只改 topic 字段**）的写盘版。
 *
 * 默认是演练：不带 --apply 时只算 diff、不写任何文件。
 * 带 --apply 时必须先自动备份 bc-index.jsonl（--no-backup 才能关，**不建议**）。
 *
 * 只改这四个字段：
 *   genericTopic / topicScore / topicConfidence / topicMinScore
 * 其余字段（generic、genericWorkflow、terms、keywords、conceptScores、vec、seq…）**原样保留**。
 * workflow 侧不动（等 baseline 够 100+ 再说）。
 *
 * 用法：
 *   node bin/relabel-apply.mjs --index <bc-index.jsonl> --raw <session.jsonl[.zstd]>
 *     [--concepts <concepts.md>] [--baseline-file <file>] [--apply] [--no-backup]
 *     [--center-min 0.02] [--lead 0.02] [--topic-min-score 0.33] [--json]
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
const flag = (name) => argv.includes(`--${name}`);

const indexFile = opt('index');
const rawFile = opt('raw');
if (!indexFile || indexFile === true || !rawFile || rawFile === true) {
  console.error('用法：node bin/relabel-apply.mjs --index <bc-index.jsonl> --raw <session.jsonl[.zstd]> [--apply]');
  process.exit(2);
}
const apply = flag('apply');
const noBackup = flag('no-backup');
const asJson = flag('json');

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

// ---------- raw ----------
function readRawLines(file) {
  if (!/\.zstd$/i.test(file)) return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
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

const events = [];
const seenSeq = new Set();
for (const line of readRawLines(rawFile)) {
  let event;
  try { event = JSON.parse(line.replace(/^\uFEFF/, '')); } catch { continue; }
  const seq = Number(event?.seq);
  if (Number.isInteger(seq)) { if (seenSeq.has(seq)) continue; seenSeq.add(seq); }
  events.push(event);
}
events.sort((a, b) => Number(a.seq) - Number(b.seq));

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

// ---------- baseline（v2 / v1 / flat） ----------
let baseline = null;
let baselineSource = 'none(raw-bootstrap)';
if (baselineFile && baselineFile !== true) {
  const raw = JSON.parse(fs.readFileSync(baselineFile, 'utf8').replace(/^\uFEFF/, ''));
  const source = raw?.topics && typeof raw.topics === 'object'
    ? raw.topics
    : (raw?.samples && typeof raw.samples === 'object' ? raw.samples : raw);
  const map = Object.fromEntries(topics.map((t) => {
    const value = source?.[t];
    if (Array.isArray(value)) {
      const nums = value.map((x) => Number(x)).filter((x) => Number.isFinite(x));
      return [t, nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : Number.NaN];
    }
    if (value === undefined || value === null || value === '') return [t, Number.NaN];
    const n = Number(value);
    return [t, Number.isFinite(n) ? n : Number.NaN];
  }));
  const known = Object.values(map).filter((v) => Number.isFinite(v));
  if (known.length > 0) {
    const fallback = known.reduce((a, b) => a + b, 0) / known.length;
    for (const t of topics) if (!Number.isFinite(map[t])) map[t] = fallback;
    baseline = map;
    baselineSource = `file:${baselineFile}`;
  }
}

// ---------- 逐行重打 topic ----------
const rows = fs.readFileSync(indexFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
const labeler = createBLabeler({ embed: embedTexts, labels, concepts, kinds });
const updated = [];
const stats = { rows: rows.length, relabelled: 0, unresolved: 0, topicChanged: 0, toEmpty: 0, fromEmpty: 0, same: 0 };
const samples = [];

for (const line of rows) {
  const record = JSON.parse(line);
  const turn = Number(record.turn);
  const entry = Number.isInteger(turn) ? turns.get(turn) : null;
  if (!entry) {
    stats.unresolved += 1;
    updated.push(line); // 原样保留
    continue;
  }
  const text = [...entry.userTexts, ...entry.assistantTexts].join('\n');
  const res = await labeler.labelChunked(text, {
    topK: 3,
    minScore,
    topicMinScore,
    topicCenterMin: centerMin,
    topicLead: lead,
    topicTopK: 1,
    topicBaseline: baseline ?? undefined,
  });
  const newTopic = (res.topic ?? [])[0]?.concept ?? null;
  const newScore = newTopic ? Number(res.topic?.[0]?.score ?? res.topicScore ?? 0) : null;
  const newConfidence = newTopic ? (res.topicConfidence ?? null) : null;
  const oldTopic = Array.isArray(record.genericTopic) && record.genericTopic.length > 0 ? record.genericTopic[0] : null;

  // 按旧字段顺序重建，只替换四个打标字段
  const next = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'genericTopic' || key === 'topicScore' || key === 'topicConfidence' || key === 'topicMinScore') continue;
    next[key] = value;
  }
  next.genericTopic = newTopic ? [newTopic] : [];
  if (newTopic) {
    next.topicScore = Number(newScore.toFixed(6));
    if (newConfidence) next.topicConfidence = newConfidence;
  }
  next.topicMinScore = topicMinScore;

  if (oldTopic !== newTopic) {
    stats.topicChanged += 1;
    if (oldTopic && !newTopic) stats.toEmpty += 1;
    if (!oldTopic && newTopic) stats.fromEmpty += 1;
    samples.push({ turn, oldTopic, newTopic });
  } else {
    stats.same += 1;
  }
  stats.relabelled += 1;
  updated.push(JSON.stringify(next));
}

const result = { apply, baselineSource, stats, samples: samples.slice(0, 40) };

if (!apply) {
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`  演练（不写盘）· index ${stats.rows} 行 · 可重打 ${stats.relabelled} · unresolved ${stats.unresolved}`);
    console.log(`  换 topic ${stats.topicChanged}（其中 topic→空 ${stats.toEmpty} · 空→topic ${stats.fromEmpty}）· 不变 ${stats.same}`);
    console.log(`  baseline ${baselineSource}`);
    for (const s of result.samples.slice(0, 12)) console.log(`    turn ${s.turn}: ${s.oldTopic ?? '(空)'} → ${s.newTopic ?? '(空)'}`);
  }
  process.exit(0);
}

// ---------- 写盘 ----------
const backup = `${indexFile}.bak-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
if (!noBackup) {
  fs.copyFileSync(indexFile, backup);
  console.log(`  已备份 → ${backup}（${fs.statSync(backup).size} B）`);
} else {
  console.log('  ⚠ --no-backup：未备份');
}
const tmp = `${indexFile}.tmp-${process.pid}`;
fs.writeFileSync(tmp, updated.join('\n') + '\n', 'utf8');

// 校验：行数一致、每行可解析、字段完整、非目标字段未变
const before = rows.map((l) => JSON.parse(l));
const after = fs.readFileSync(tmp, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
if (after.length !== before.length) throw new Error(`行数不一致 ${before.length} → ${after.length}`);
const target = new Set(['genericTopic', 'topicScore', 'topicConfidence', 'topicMinScore']);
let touchedOther = 0;
for (let i = 0; i < before.length; i += 1) {
  const a = before[i];
  const b = after[i];
  for (const key of Object.keys(a)) {
    if (target.has(key)) continue;
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) touchedOther += 1;
  }
}
if (touchedOther > 0) throw new Error(`非目标字段被改动 ${touchedOther} 处，已中止（原文件未动）`);
fs.renameSync(tmp, indexFile);
console.log(`  已写盘：${indexFile}`);
console.log(`  重打 ${stats.relabelled} · unresolved ${stats.unresolved} · 换 topic ${stats.topicChanged}（→空 ${stats.toEmpty} · 空→topic ${stats.fromEmpty}）· 不变 ${stats.same}`);
console.log('  校验通过：行数一致、非目标字段零改动');
