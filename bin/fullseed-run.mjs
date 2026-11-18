#!/usr/bin/env node
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { buildRawChunks, verifyChunk } from '../src/fullseed/chunks.mjs';
import { buildIdentity, dryRun, runSeed } from '../src/fullseed/seed.mjs';
import { PROMPT_TEXT_SHA256, EXTRACTION_RULE_SHA256 } from '../src/fullseed/summary.mjs';
import { normalizeCheckpoint } from '../src/fullseed/checkpoint.mjs';

function decode(file) {
  const buf = fs.readFileSync(file);
  if (!file.endsWith('.zstd')) return buf.toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  let pos = 0; let text = '';
  while (pos < buf.length) {
    const start = buf.indexOf(magic, pos);
    if (start < 0) break;
    const next = buf.indexOf(magic, start + 4);
    const end = next < 0 ? buf.length : next;
    text += zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8');
    pos = end;
  }
  return text.split(/\r?\n/).filter(Boolean).map(JSON.parse);
}
function arg(name, fallback = null) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; }
const raw = arg('--raw'); const sessionId = arg('--session'); const home = arg('--home');
const approve = process.argv.includes('--approve');
const checkpoint = normalizeCheckpoint(arg('--checkpoint', 'Infinity'), { approve });
if (!raw || !sessionId) { console.error('usage: fullseed-run --raw <file> --session <id> --home <dir> [--checkpoint N] [--approve --expected-chunks N --max-calls N --provider-module file]'); process.exit(2); }
const events = decode(raw); const chunks = buildRawChunks(sessionId, events, { checkpointSeq: checkpoint }).chunks;
const eventsBySeq = new Map(events.map((e) => [Number(e.seq), e]));
const identity = arg('--identity') ?? buildIdentity({ promptTextSha256: PROMPT_TEXT_SHA256, extractionRuleSha256: EXTRACTION_RULE_SHA256 });
if (process.argv.includes('--approve')) {
  if (!home) throw new Error('--home required for actual run');
  const expected = Number(arg('--expected-chunks')); const maxCalls = Number(arg('--max-calls')); const modulePath = arg('--provider-module');
  if (!Number.isInteger(expected) || expected !== chunks.length) throw new Error(`chunk count mismatch: expected ${expected}, got ${chunks.length}`);
  if (!Number.isInteger(maxCalls) || maxCalls < chunks.length) throw new Error('max-calls must cover at least one attempt per chunk');
  if (!modulePath) throw new Error('provider module required');
  const failed = chunks.filter((c) => { try { return !verifyChunk(c, eventsBySeq); } catch { return true; } });
  if (failed.length > 0) throw new Error(`raw verification failed for ${failed.length} chunks`);
  const { pathToFileURL } = await import('node:url');
  const mod = await import(pathToFileURL(modulePath).href);
  const { provider, embedder } = await mod.createProvider();
  const result = await runSeed({ chunks, root: home, provider, embedder, identity, checkpoint, snapshotBoundary: checkpoint, maxAttempts: 2, maxProviderCalls: maxCalls });
  console.log(JSON.stringify({ chunks: chunks.length, pending: result.pending, active: result.active, weakNounsRate: result.weakNounsRate, calls: result.calls.length, usage: result.calls.reduce((n, c) => n + (c.usage?.totalTokens ?? 0), 0) }, null, 2));
} else {
  console.log(JSON.stringify({ ...dryRun({ chunks }), events: events.length, sessionId, checkpoint, identity, chunkSetSha256: createHash('sha256').update(chunks.map((c) => c.chunkId).sort().join('\n')).digest('hex'), firstChunk: chunks[0]?.chunkId, lastChunk: chunks.at(-1)?.chunkId }, null, 2));
}
