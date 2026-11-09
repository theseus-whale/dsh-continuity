#!/usr/bin/env node
/**
 * Build the middle-layer summary index from one raw session.
 *
 * Phase 0/1:
 *   - imports existing compaction/summary records (native checkpoint + gist)
 *   - plans missing windows by seq/token gaps
 *   - dry-run by default; --apply writes summaries/index.json
 *
 * Usage:
 *   node bin/summary-index.mjs --raw <session.v4.jsonl.zstd> [--out <index.json>] [--json]
 *   node bin/summary-index.mjs --raw ... --apply [--session-dir <dir>]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildSummaryIndex, summaryIndexPath } from '../src/memory/summary-index.mjs';
import { buildWindowSummary } from '../src/memory/window-summary.mjs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? fallback : fallback;
}

function readRawLines(file) {
  if (!/\.zstd$/i.test(file)) {
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  }
  const buf = fs.readFileSync(file);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const starts = [];
  for (let at = 0; ;) {
    const found = buf.indexOf(magic, at);
    if (found < 0) break;
    starts.push(found);
    at = found + magic.length;
  }
  const lines = [];
  for (const start of starts) {
    let out;
    try { out = zlib.zstdDecompressSync(buf.subarray(start)); } catch { continue; }
    lines.push(...out.toString('utf8').split(/\r?\n/).filter(Boolean));
  }
  return lines;
}

const raw = arg('raw');
if (!raw) {
  console.error('用法: node bin/summary-index.mjs --raw <session.v4.jsonl[.zstd]> [--out <index.json>] [--apply] [--json]');
  process.exit(2);
}
if (!fs.existsSync(raw)) {
  console.error(`raw not found: ${raw}`);
  process.exit(2);
}

const sessionDirArg = arg('session-dir');
const sessionDir = sessionDirArg ?? path.dirname(raw);
const sessionId = arg('session-id', path.basename(sessionDir));
const windowTokens = Math.max(1000, Number(arg('window-tokens', 40000)) || 40000);
const outArg = arg('out');
const out = outArg ?? (sessionDirArg ? summaryIndexPath(sessionDirArg) : null);
const apply = process.argv.includes('--apply');
const extractPending = process.argv.includes('--extract-pending');
const printJson = process.argv.includes('--json');
if (apply && !out) {
  console.error('--apply requires explicit --session-dir (Continuity session dir) or --out');
  process.exit(2);
}

const events = [];
const seen = new Set();
for (const line of readRawLines(raw)) {
  let event;
  try { event = JSON.parse(line.replace(/^\uFEFF/, '')); } catch { continue; }
  const seq = Number(event?.seq);
  if (Number.isInteger(seq)) {
    if (seen.has(seq)) continue;
    seen.add(seq);
  }
  events.push(event);
}
events.sort((a, b) => Number(a.seq) - Number(b.seq));

const bootstrapFile = path.join(sessionDir, 'summaries', 'bootstrap-ranges.json');
let bootstrapRanges = [];
try {
  if (fs.existsSync(bootstrapFile)) {
    const parsed = JSON.parse(fs.readFileSync(bootstrapFile, 'utf8'));
    if (Array.isArray(parsed?.ranges)) bootstrapRanges = parsed.ranges;
  }
} catch { /* malformed sidecar is ignored; index still builds */ }

const baseIndex = buildSummaryIndex({ sessionId, events, windowTokens, bootstrapRanges });
const windowSummaries = extractPending
  ? baseIndex.pendingWindows.map((pending) => buildWindowSummary({
    events,
    fromSeq: pending.fromSeq,
    toSeq: pending.toSeq,
    maxTokens: 800,
  }))
  : [];
const windowRanges = windowSummaries.map((summary) => ({
  fromSeq: summary.fromSeq,
  toSeq: summary.toSeq,
  tokens: summary.approxTokens,
  hash: summary.hash,
  at: new Date().toISOString(),
}));
const index = windowSummaries.length > 0
  ? buildSummaryIndex({ sessionId, events, windowTokens, bootstrapRanges, windowRanges, windowRecords: windowSummaries })
  : baseIndex;
if (apply && extractPending) {
  const windowDir = path.join(path.dirname(out), 'windows');
  fs.mkdirSync(windowDir, { recursive: true });
  for (const summary of windowSummaries) {
    fs.writeFileSync(
      path.join(windowDir, `${summary.fromSeq}-${summary.toSeq}.json`),
      JSON.stringify(summary, null, 2),
      'utf8',
    );
  }
}
if (apply) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf8');
  fs.renameSync(tmp, out);
}

if (printJson) {
  console.log(JSON.stringify(index, null, 2));
} else {
  console.log(JSON.stringify({
    sessionId: index.sessionId,
    raw: path.resolve(raw),
    out: apply ? path.resolve(out) : null,
    apply,
    windowTokens: index.windowTokens,
    maxSummarySeq: index.maxSummarySeq,
    coveredThroughSeq: index.coveredThroughSeq,
    latestSummaryAt: index.latestSummaryAt,
    records: index.records.length,
    checkpoints: index.records.filter((record) => record.kind === 'checkpoint').length,
    gists: index.records.filter((record) => record.kind === 'gist').length,
    pendingWindows: index.pendingWindows.length,
    pending: index.pendingWindows.slice(0, 8),
    extractedWindows: windowSummaries.length,
    coverage: index.coverage,
  }, null, 2));
}
