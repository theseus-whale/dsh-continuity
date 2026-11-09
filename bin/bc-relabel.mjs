#!/usr/bin/env node
/**
 * One-shot concept migration: re-label every turn in an existing index using
 * concepts.md, write a NEW file, and validate before replacing anything.
 *
 * Usage:
 *   node bin/bc-relabel.mjs --index <bc-index.jsonl> --turns <turns.jsonl> \
 *     --concepts <concepts.md> --out <new-index.jsonl> [--write]
 *
 * turns.jsonl: one JSON object per line: { "turn": number, "text": string }
 * The tool never edits the source index. Without --write it only reports.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createBLabeler } from '../src/memory/bc-label.mjs';
import { embedTexts } from '../src/facets/embedding.mjs';
import { loadIndexJsonl, saveIndexJsonl } from '../src/memory/bc-index.mjs';
import { loadConcepts } from '../src/memory/concepts-file.mjs';
import { buildDf, chatterScore } from '../src/memory/chatter.mjs';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}
function has(name) {
  return process.argv.includes(`--${name}`);
}

const indexFile = arg('index');
const turnsFile = arg('turns');
const conceptsFile = arg('concepts');
const outFile = arg('out');
if (!indexFile || !turnsFile || !outFile) {
  console.error('missing --index / --turns / --out');
  process.exit(2);
}
const rows = loadConcepts(conceptsFile ?? undefined);
console.log(JSON.stringify({ concepts: rows.length, names: rows.map((row) => row.label) }, null, 2));

const labels = Object.fromEntries(rows.map((row) => [row.label, row.description]));
const turns = new Map();
for (const line of fs.readFileSync(turnsFile, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  const item = JSON.parse(line);
  if (Number.isInteger(item.turn) && typeof item.text === 'string') turns.set(item.turn, item.text);
}
const records = loadIndexJsonl(indexFile);
const missing = records.filter((record) => !turns.has(record.turn)).map((record) => record.turn);
if (missing.length > 0) {
  console.error(`missing turn text for ${missing.length} records: ${missing.slice(0, 10).join(', ')}`);
  process.exit(3);
}
if (has('vectors')) {
  const df = buildDf(records.map((record) => turns.get(record.turn) ?? ''));
  const next = [];
  for (let i = 0; i < records.length; i += 16) {
    const batch = records.slice(i, i + 16);
    const todo = batch.filter((record) => typeof record.vec !== 'string' || !record.vec);
    const vectors = todo.length > 0 ? await embedTexts(todo.map((record) => turns.get(record.turn) ?? '')) : [];
    let cursor = 0;
    for (const record of batch) {
      if (typeof record.vec === 'string' && record.vec) {
        next.push(record);
      } else {
        const vector = vectors[cursor++];
        next.push({
          ...record,
          vec: Buffer.from(new Float32Array(vector).buffer).toString('base64'),
          chatter: Number(chatterScore(turns.get(record.turn) ?? '', df).toFixed(4)),
        });
      }
    }
  }
  const bad = next.filter((record) => {
    const buffer = Buffer.from(record.vec ?? '', 'base64');
    return !buffer.length || !(record.chatter >= 0 && record.chatter <= 1);
  });
  console.log(JSON.stringify({ records: next.length, existing: records.length - next.filter((record) => !record.vec).length, bad: bad.length }, null, 2));
  if (bad.length > 0) process.exit(4);
  if (!has('write')) {
    console.log('dry-run only; add --write to emit the vector index');
    process.exit(0);
  }
  saveIndexJsonl(outFile, next);
  console.log(`wrote ${outFile}`);
  process.exit(0);
}
if (rows.length === 0) {
  console.error('concepts.md has no valid rows');
  process.exit(2);
}
const labeler = createBLabeler({ embed: embedTexts, labels, concepts: Object.keys(labels) });
const checks = [
  [1323, '跑团叙事'],
  [6, '插件开发'],
  [866, '线程标签'],
  [1584, '手机与流量'],
  [1598, '权限与通知'],
  [1612, '权限与通知'],
  [827, '补丁与验证'],
  [827, '备份与重启'],
  [866, '关键词与标签'],
];
const next = [];
for (const record of records) {
  const label = await labeler.label(turns.get(record.turn), { topK: Object.keys(labels).length, minScore: 0 });
  const scores = Object.fromEntries(label.candidates.map((candidate) => [candidate.concept, candidate.score]));
  const generic = label.candidates.filter((candidate) => candidate.score >= 0.25).slice(0, 3).map((candidate) => candidate.concept);
  next.push({
    ...record,
    generic,
    conceptScores: scores,
    confidence: label.top?.score ?? 0,
    status: 'weak',
  });
}
const checkResults = checks.map(([turn, concept]) => {
  const record = next.find((item) => item.turn === turn);
  if (!record) return { turn, concept, missing: true };
  const ranked = Object.entries(record.conceptScores ?? {}).sort((a, b) => b[1] - a[1]);
  const rank = ranked.findIndex(([name]) => name === concept) + 1;
  return {
    turn,
    concept,
    textLength: String(turns.get(turn) ?? '').length,
    score: record.conceptScores?.[concept] ?? null,
    rank,
    top3: ranked.slice(0, 3).map(([name, score]) => ({ name, score: Number(score.toFixed(3)) })),
    vector: turn === 827 ? ranked.map(([name, score]) => ({ name, score: Number(score.toFixed(3)) })) : undefined,
  };
});
const bad = next.filter((record) => (record.generic ?? []).some((name) => !labels[name]));
if (bad.length > 0) {
  console.error(`records with unknown concept names: ${bad.length}`);
  process.exit(4);
}
console.log(JSON.stringify({ index: indexFile, records: records.length, out: outFile, missing: 0, bad: 0, checks: checkResults }, null, 2));
if (!has('write')) {
  console.log('dry-run only; add --write to emit the new index');
  process.exit(0);
}
const temp = `${outFile}.tmp`;
saveIndexJsonl(temp, next);
const parsed = loadIndexJsonl(temp);
if (parsed.length !== records.length) {
  console.error(`validation failed: wrote ${parsed.length}, expected ${records.length}`);
  process.exit(5);
}
fs.renameSync(temp, outFile);
console.log(`wrote ${outFile}`);
