#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadActiveIndex } from '../src/fullseed/cache.mjs';
import { buildChunkTimeline } from '../src/fullseed/continuation-shadow.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const root = argOf('--root');
const output = argOf('--output');
const excludePaths = String(argOf('--exclude') ?? '').split(',').filter(Boolean);
const seed = argOf('--seed') ?? 'continuation-window-shadow2-v1';
if (!root || !output || excludePaths.length === 0) {
  console.error('usage: node bin/memory-continuation-window-anchors.mjs --root <fullseed> --exclude <old1.jsonl,old2.jsonl,...> --output <anchors.jsonl> [--seed text]');
  process.exit(2);
}

const active = loadActiveIndex(path.resolve(root), { fresh: true });
if (!active) throw new Error('active.json not found');
const timeline = buildChunkTimeline(active.merged.summaries, active.merged.vectors);
const excludedIds = new Set();
const excludedRanges = new Set();
for (const excludePath of excludePaths) {
  const rows = fs.readFileSync(path.resolve(excludePath), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  for (const row of rows) {
    if (row.anchorChunkId) excludedIds.add(row.anchorChunkId);
    const match = /^(\d+)-(\d+)$/.exec(String(row.from ?? row.anchor ?? ''));
    if (match) excludedRanges.add(`${match[1]}-${match[2]}`);
  }
}
const eligible = timeline.map((chunk, index) => ({ chunk, index })).filter(({ chunk, index }) => index >= 20
  && index < timeline.length - 20
  && !excludedIds.has(chunk.chunkId)
  && !excludedRanges.has(`${chunk.seqStart}-${chunk.seqEnd}`));
if (eligible.length < 4) throw new Error('fewer than four eligible anchors');

const selected = [];
for (let stratum = 0; stratum < 4; stratum += 1) {
  const start = Math.floor(stratum * eligible.length / 4);
  const end = Math.floor((stratum + 1) * eligible.length / 4);
  const candidates = eligible.slice(start, end);
  if (candidates.length === 0) throw new Error(`empty stratum ${stratum + 1}`);
  candidates.sort((left, right) => {
    const leftHash = createHash('sha256').update(`${seed}\0${left.chunk.chunkId}`).digest('hex');
    const rightHash = createHash('sha256').update(`${seed}\0${right.chunk.chunkId}`).digest('hex');
    return leftHash.localeCompare(rightHash) || left.chunk.chunkId.localeCompare(right.chunk.chunkId);
  });
  const { chunk, index } = candidates[0];
  selected.push({
    from: `${chunk.seqStart}-${chunk.seqEnd}`,
    fromChunkId: chunk.chunkId,
    fromChunkIndex: chunk.chunkIndex,
    stratum: stratum + 1,
    eligibleOrdinal: index,
    eligibleCount: eligible.length,
    seed,
    checkpoint: active.active.checkpoint ?? null,
  });
}
const bytes = `${selected.map((row) => JSON.stringify(row)).join('\n')}\n`;
fs.writeFileSync(path.resolve(output), bytes);
console.error(JSON.stringify({ output: path.resolve(output), chunks: timeline.length, eligible: eligible.length, anchors: selected.length }));
