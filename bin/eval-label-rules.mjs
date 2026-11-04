#!/usr/bin/env node
/**
 * eval-label-rules.mjs — 评估 A 表打标判据（top-1 / top-2 / 空值 / 精度 / 覆盖 / 误标率）。
 *
 * 输入是一个 JSONL，每行：
 *   {"turn": 2056, "text": "……这一轮的正文……", "label": "跑团叙事"}
 * 其中 label 是人工定的主话题（可以留空字符串表示"人工认为该判空"）。
 *
 * 用法：
 *   node bin/eval-label-rules.mjs --input rows.jsonl
 *   node bin/eval-label-rules.mjs --input rows.jsonl --baseline-file topic-baseline.json
 *   node bin/eval-label-rules.mjs --input rows.jsonl --center-min 0.02 --lead 0.02 --json
 *
 * 选项：
 *   --input <file>          必填，JSONL
 *   --concepts <file>       A 表（默认 包内 templates/concepts.md；找不到则报错）
 *   --baseline-file <file>  生产 baseline（支持 {"topic":0.51} 或 {version,window,samples:{topic:[...]}}）。
 *                           不给则用输入集的 leave-one-out 均值——**仅用于评估**，不是生产语义。
 *   --center-min <n>        centered 下限（默认 0.02）
 *   --lead <n>              领先第二名的下限（默认 0.02）
 *   --topic-min-score <n>   绝对下限保险（默认 0.33）
 *   --min-score <n>         workflow 入选下限（默认 0.25）
 *   --topk <n>              topic 最多返回几条（默认 2）
 *   --min-precision <n>     低于该精度时退出码 1（默认不设）
 *   --json                  只输出 JSON 摘要
 *
 * 注意：本脚本不读会话原文，也不写任何会话文件；输入里有什么就只算什么。
 */
import fs from 'node:fs';
import path from 'node:path';
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

const inputPath = opt('input');
if (!inputPath || inputPath === true) {
  console.error('缺 --input <jsonl>');
  process.exit(2);
}
const conceptsPath = (() => {
  const explicit = opt('concepts');
  if (explicit && explicit !== true) return explicit;
  const candidate = path.join(pkgRoot, 'templates', 'concepts.md');
  return fs.existsSync(candidate) ? candidate : null;
})();
if (!conceptsPath || !fs.existsSync(conceptsPath)) {
  console.error('找不到 A 表：请用 --concepts <concepts.md> 指定');
  process.exit(2);
}

const centerMin = num('center-min', 0.02);
const lead = num('lead', 0.02);
const topicMinScore = num('topic-min-score', 0.33);
const minScore = num('min-score', 0.25);
const topk = num('topk', 2);
const minPrecision = num('min-precision', null);
const asJson = Boolean(opt('json', false));
const baselineFile = opt('baseline-file');

const { createBLabeler } = await import('file://' + path.join(pkgRoot, 'src/memory/bc-label.mjs'));
const { loadConcepts } = await import('file://' + path.join(pkgRoot, 'src/memory/concepts-file.mjs'));
const { embedTexts } = await import('file://' + path.join(pkgRoot, 'src/facets/embedding.mjs'));

const rows = loadConcepts(conceptsPath);
if (rows.length === 0) {
  console.error('A 表为空：' + conceptsPath);
  process.exit(2);
}
const labels = Object.fromEntries(rows.map((r) => [r.label, r.description]));
const kinds = Object.fromEntries(rows.map((r) => [r.label, r.kind]));
const concepts = rows.map((r) => r.label);
const topics = rows.filter((r) => r.kind === 'topic').map((r) => r.label);

const samples = fs.readFileSync(inputPath, 'utf8')
  .split(/\r?\n/)
  .filter((line) => line.trim() !== '')
  .map((line, index) => {
    try {
      const row = JSON.parse(line);
      return {
        turn: row.turn ?? index + 1,
        text: String(row.text ?? ''),
        label: String(row.label ?? ''),
      };
    } catch (error) {
      console.error(`第 ${index + 1} 行 JSON 解析失败：${error.message}`);
      process.exit(2);
    }
  });
if (samples.length === 0) {
  console.error('输入为空');
  process.exit(2);
}

const labeler = createBLabeler({ embed: embedTexts, labels, concepts, kinds });

// baseline：生产文件优先；否则用输入集 leave-one-out 均值（仅评估用）
let baseline = null;
let baselineSource = 'leave-one-out';
if (baselineFile && baselineFile !== true) {
  const raw = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  const source = raw?.samples && typeof raw.samples === 'object' ? raw.samples : raw;
  baseline = Object.fromEntries(topics.map((t) => {
    const value = source?.[t];
    if (Array.isArray(value)) {
      return [t, value.length > 0 ? value.reduce((sum, item) => sum + Number(item || 0), 0) / value.length : 0];
    }
    return [t, Number(value ?? 0)];
  }));
  baselineSource = baselineFile;
}

// 先算一遍 raw，够用来做 leave-one-out 均值
const results = [];
for (const sample of samples) {
  const res = await labeler.labelChunked(sample.text, {
    topK: 3,
    minScore,
    topicMinScore,
    topicCenterMin: centerMin,
    topicLead: lead,
    topicTopK: topk,
    topicBaseline: baseline ?? undefined,
  });
  results.push({ sample, res });
}

let effectiveBaseline = baseline;
if (!baseline) {
  const sums = Object.fromEntries(topics.map((t) => [t, 0]));
  let count = 0;
  for (const { res } of results) {
    const scores = res.topicScores ?? {};
    const keys = topics.filter((t) => Number.isFinite(Number(scores[t])));
    if (keys.length === 0) continue;
    for (const t of keys) sums[t] += Number(scores[t]);
    count += 1;
  }
  if (count > 0) {
    effectiveBaseline = Object.fromEntries(topics.map((t) => [t, sums[t] / count]));
    // leave-one-out：重新打一遍
    for (const item of results) {
      const scores = item.res.topicScores ?? {};
      const loo = Object.fromEntries(topics.map((t) => {
        const own = Number(scores[t]);
        if (!Number.isFinite(own) || count <= 1) return [t, effectiveBaseline[t] ?? 0];
        return [t, (sums[t] - own) / (count - 1)];
      }));
      item.res = await labeler.labelChunked(item.sample.text, {
        topK: 3,
        minScore,
        topicMinScore,
        topicCenterMin: centerMin,
        topicLead: lead,
        topicTopK: topk,
        topicBaseline: loo,
      });
    }
  }
}

let nonEmpty = 0;
let empty = 0;
let correct = 0;
let wrong = 0;
let top2Hit = 0;
let labelled = 0;
const mistakes = [];
const perRow = [];

for (const { sample, res } of results) {
  const picked = (res.topic ?? []).map((item) => item.concept);
  const got = picked[0] ?? null;
  const want = sample.label.trim();
  const hasHuman = want !== '';
  if (hasHuman) labelled += 1;
  if (got === null) empty += 1;
  else nonEmpty += 1;
  const ok = got !== null && hasHuman && got === want;
  const inTop2 = hasHuman && picked.slice(0, 2).includes(want);
  if (ok) correct += 1;
  if (got !== null && hasHuman && !ok) { wrong += 1; mistakes.push({ turn: sample.turn, got, want }); }
  if (inTop2) top2Hit += 1;
  perRow.push({ turn: sample.turn, got, want, ok, top: picked });
}

const total = results.length;
const precision = nonEmpty > 0 ? correct / nonEmpty : 0;
const coverage = total > 0 ? nonEmpty / total : 0;
const mislabelRate = total > 0 ? wrong / total : 0;
const top2Rate = labelled > 0 ? top2Hit / labelled : 0;

const summary = {
  rows: total,
  labelled,
  nonEmpty,
  empty,
  correct,
  wrong,
  precision: Number(precision.toFixed(3)),
  coverage: Number(coverage.toFixed(3)),
  mislabelRate: Number(mislabelRate.toFixed(3)),
  top2Rate: Number(top2Rate.toFixed(3)),
  centerMin,
  lead,
  topicMinScore,
  baselineSource,
  mistakes,
};

if (asJson) {
  console.log(JSON.stringify({ summary, rows: perRow }, null, 2));
} else {
  console.log(`  A 表 ${rows.length} 条（topic ${topics.length} / workflow ${rows.length - topics.length}）· 输入 ${total} 行 · 有标签 ${labelled} 行`);
  console.log(`  判据 centered≥${centerMin} 且 lead≥${lead} · 绝对下限 ${topicMinScore} · baseline ${baselineSource}`);
  console.log('');
  console.log(`  非空 ${nonEmpty}/${total} · 命中 ${correct} · 误标 ${wrong} · 空 ${empty}`);
  console.log(`  精度 ${(precision * 100).toFixed(0)}% · 覆盖率 ${(coverage * 100).toFixed(0)}% · 误标率 ${(mislabelRate * 100).toFixed(0)}% · top-2 ${(top2Rate * 100).toFixed(0)}%`);
  if (mistakes.length > 0) {
    console.log('');
    console.log('  误标：');
    for (const m of mistakes) console.log(`    turn ${m.turn}: 机器 ${m.got} / 人工 ${m.want}`);
  }
}

if (minPrecision !== null && precision < minPrecision) {
  process.exitCode = 1;
}
