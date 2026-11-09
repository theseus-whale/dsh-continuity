#!/usr/bin/env node
/**
 * Read-only query over the Continuity summary index.
 * This is a first step for recall's summaryHits; no model, no writes.
 *
 * Usage:
 *   node bin/summary-query.mjs --index <index.json> --query "..." [--limit 5] [--json]
 *   node bin/summary-query.mjs --session-dir <dir> --query "..."
 */
import fs from 'node:fs';
import path from 'node:path';
import { summaryIndexPath } from '../src/memory/summary-index.mjs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? fallback : fallback;
}

const sessionDir = arg('session-dir');
const indexFile = arg('index', sessionDir ? summaryIndexPath(sessionDir) : null);
const query = String(arg('query', '')).trim();
const limit = Math.min(Math.max(Number(arg('limit', 5)) || 5, 1), 50);
const json = process.argv.includes('--json');
if (!indexFile || !fs.existsSync(indexFile)) {
  console.error('summary index not found; pass --index or --session-dir');
  process.exit(2);
}
if (!query) {
  console.error('query required');
  process.exit(2);
}

const index = JSON.parse(fs.readFileSync(indexFile, 'utf8').replace(/^\uFEFF/, ''));
const q = query.normalize('NFKC').toLowerCase();
const qChars = [...q];
const cjkQuery = /[\u3400-\u9fff]/.test(q);
const records = Array.isArray(index.records) ? index.records : [];
const scored = [];
for (const record of records) {
  const text = String(record.text ?? '').normalize('NFKC').toLowerCase();
  if (!text) continue;
  let score = 0;
  const exact = text.includes(q);
  if (exact) score += 100;
  if (cjkQuery && qChars.length >= 2) {
    const covered = qChars.filter((ch) => text.includes(ch)).length;
    if (covered === qChars.length) score += 5;
  }
  if (score > 0) scored.push({ record, score, exact });
}
scored.sort((a, b) => b.score - a.score || b.record.toSeq - a.record.toSeq);
const hits = scored.slice(0, limit).map(({ record, score, exact }) => ({
  id: record.id,
  kind: record.kind,
  fromSeq: record.fromSeq,
  toSeq: record.toSeq,
  fromTurn: record.fromTurn,
  toTurn: record.toTurn,
  threads: record.threads,
  approxTokens: record.approxTokens,
  score: Number(score.toFixed(2)),
  exact,
  excerpt: String(record.text ?? '').slice(0, 500),
}));
const result = {
  index: path.resolve(indexFile),
  query,
  total: scored.length,
  shown: hits.length,
  hits,
};
if (json) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`query=${query} total=${result.total} shown=${result.shown}`);
  for (const hit of hits) {
    console.log(`\n[${hit.kind}] ${hit.id} · turn ${hit.fromTurn ?? '?'}-${hit.toTurn ?? '?'} · seq ${hit.fromSeq}-${hit.toSeq} · score ${hit.score}`);
    console.log(hit.excerpt.replace(/\s+/g, ' ').slice(0, 300));
  }
}
