#!/usr/bin/env node
/**
 * Offline expand-hint reminder tool.
 * Reads an index + turn texts, clusters, and prints candidate topic clusters.
 * Never writes concepts/index. --write only appends to expand-hint.jsonl.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { embedTexts } from '../src/facets/embedding.mjs';
import { extractKeywords } from '../src/memory/bc-recall.mjs';
import { loadIndexJsonl } from '../src/memory/bc-index.mjs';
import { loadConcepts } from '../src/memory/concepts-file.mjs';

function arg(name, fallback = null) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] ?? fallback : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);
const indexFile = arg('index', path.join(os.homedir(), '.dsh', 'continuity', 'bc-index.jsonl'));
const conceptsFile = arg('concepts', path.join(os.homedir(), '.dsh', 'continuity', 'concepts.md'));
const turnsFile = arg('turns');
const outFile = arg('out', path.join(os.homedir(), '.dsh', 'continuity', 'expand-hint.jsonl'));
const verdict = arg('record-verdict');
if (verdict) {
  if (!['accepted', 'rejected'].includes(verdict)) {
    console.error('--record-verdict must be accepted or rejected');
    process.exit(2);
  }
  const event = {
    at: new Date().toISOString(),
    event: 'verdict',
    by: 'cli',
    verdict,
    auditAt: arg('audit-at', ''),
    reason: arg('reason', ''),
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.appendFileSync(outFile, `${JSON.stringify(event)}\n`, 'utf8');
  console.log(`recorded ${verdict}`);
  process.exit(0);
}
if (!turnsFile) {
  console.error('missing --turns <turns.jsonl>');
  process.exit(2);
}
const until = Number(arg('until', Infinity));
const records = loadIndexJsonl(indexFile).filter((record) => !Number.isFinite(until) || record.turn <= until);
if (records.length === 0) {
  console.error('index has no records');
  process.exit(2);
}
const rows = loadConcepts(conceptsFile);
if (rows.length === 0) {
  console.error('concepts.md has no valid rows');
  process.exit(2);
}
const concepts = rows.map((row) => row.label);
const textByTurn = new Map(fs.readFileSync(turnsFile, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
  const row = JSON.parse(line);
  return [row.turn, row.text];
}));
const missing = records.filter((record) => !textByTurn.has(record.turn));
if (missing.length > 0) {
  console.error(`missing turn text for ${missing.length} records: ${missing.slice(0, 8).map((r) => r.turn).join(', ')}`);
  process.exit(3);
}

const N = records.length;
const k = Number(arg('k', Math.max(20, Math.min(60, Math.round(N / 50))))) || 30;
const minSize = Number(arg('min-size', 10)) || 10;
const topN = Number(arg('top', 5)) || 5;
const maxTopic = Number(arg('max-topic', 0.5));

const norm = (v) => {
  const n = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1;
  return v.map((x) => x / n);
};
const cos = (a, b) => {
  let dot = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) dot += a[i] * b[i];
  return dot;
};
const texts = records.map((record) => String(textByTurn.get(record.turn) ?? ''));
const vectors = [];
for (let i = 0; i < texts.length; i += 16) vectors.push(...await embedTexts(texts.slice(i, i + 16)));
const points = records.map((record, i) => ({ turn: record.turn, v: norm(vectors[i]), record }));

// chatterScore
const df = new Map();
const tokensByTurn = new Map();
for (const [turn, text] of textByTurn) {
  const tokens = [...String(text).matchAll(/[\u4e00-\u9fff]{2,6}/g)].map((m) => m[0]);
  tokensByTurn.set(turn, tokens);
  for (const token of new Set(tokens)) df.set(token, (df.get(token) ?? 0) + 1);
}
const functionRe = /[浜嗙殑鐫€鍚楀憿鍚у晩]/g;
const chatterScore = (turn) => {
  const text = String(textByTurn.get(turn) ?? '');
  const tokens = tokensByTurn.get(turn) ?? [];
  const cjkTotal = tokens.length;
  const proper = tokens.filter((token) => (df.get(token) ?? 0) <= 3).length;
  const properDensity = cjkTotal ? proper / cjkTotal : 0;
  const fnCount = (text.match(functionRe) ?? []).length;
  const fnDensity = fnCount / Math.max(1, text.length);
  const keywordSparse = extractKeywords(text, { limit: 10 }).length < 3 ? 1 : 0;
  const quotes = (text.match(/[「」“”"——]/g) ?? []).length;
  return 0.30 * (text.length < 60 ? 1 : 0)
    + 0.25 * Math.min(1, properDensity)
    + 0.20 * Math.min(1, fnDensity * 20)
    + 0.15 * keywordSparse
    + 0.10 * (quotes > 0 ? 1 : 0);
};

// Deterministic k-means (seeded init, cosine).
let seed = 42;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const centers = [];
const used = new Set();
while (centers.length < k) {
  const index = Math.floor(rand() * points.length);
  if (used.has(index)) continue;
  used.add(index);
  centers.push(points[index].v);
}
let groups = [];
for (let iteration = 0; iteration < 15; iteration += 1) {
  groups = centers.map((center) => ({ center, members: [] }));
  for (const point of points) {
    let best = 0;
    let bestScore = -Infinity;
    for (let c = 0; c < centers.length; c += 1) {
      const score = cos(point.v, centers[c]);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    groups[best].members.push(point);
  }
  for (let c = 0; c < centers.length; c += 1) {
    if (groups[c].members.length === 0) continue;
    const sum = new Array(points[0].v.length).fill(0);
    for (const point of groups[c].members) for (let i = 0; i < sum.length; i += 1) sum[i] += point.v[i];
    centers[c] = norm(sum);
  }
}
const clusters = groups.filter((group) => group.members.length >= minSize).map((group) => {
  const turns = group.members.map((point) => point.turn);
  const topicMax = group.members.reduce((sum, point) => {
    const scores = point.record.conceptScores ?? {};
    return sum + Math.max(0, ...concepts.map((name) => scores[name] ?? 0));
  }, 0) / group.members.length;
  const chatter = group.members.reduce((sum, point) => sum + chatterScore(point.turn), 0) / group.members.length;
  const kw = [...new Set(extractKeywords(turns.map((turn) => textByTurn.get(turn) ?? '').join('\n'), { limit: 30 })
    .map((word) => String(word).toLowerCase()))].filter((word) => word.length >= 2).slice(0, 6);
  return { turns, size: turns.length, start: Math.min(...turns), end: Math.max(...turns), topicMax, chatter, kw };
});
const candidates = clusters.filter((cluster) => cluster.topicMax < maxTopic)
  .sort((a, b) => a.topicMax - b.topicMax || b.size - a.size)
  .slice(0, topN);
if (candidates.length === 0) {
  console.log('no candidates');
  process.exit(0);
}
for (const item of candidates) {
  console.log(`turn ${item.start}-${item.end} - ${item.size}轮 - topicMax ${item.topicMax.toFixed(2)} - chatter ${item.chatter.toFixed(2)} - kw ${item.kw.join('/')}`);
  console.log('    → topicMax<0.5 且 kw 是话题词（非人名/道具/英文标识符）才考虑加；加就一步：concepts.md 追加 `名字 | 词1、词2… | 覆盖估算`');
}
if (has('write')) {
  const at = new Date().toISOString();
  const lines = candidates.map((item) => JSON.stringify({
    at, event: 'pending', range: [item.start, item.end], size: item.size,
    topicMax: Number(item.topicMax.toFixed(2)), chatter: Number(item.chatter.toFixed(2)), kw: item.kw,
  }));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.appendFileSync(outFile, `${lines.join('\n')}\n`, 'utf8');
}

