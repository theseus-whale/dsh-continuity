#!/usr/bin/env node
/**
 * Scale benchmark for the exact durable-memory layers.
 * Replicates the real 1,462-turn copy to 10k/50k for latency/memory testing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildEventLog } from '../src/memory/event-log.mjs';
import { BM25Index } from '../src/memory/bm25.mjs';
import { VectorIndex } from '../src/memory/vector-index.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = argOf('--dir') ?? 'C:/Users/35794/Documents/DeepSeek\'s Sandbox/coopanion-continuity/backups/continuity-tags-20261031/durable-memory/build-a';
const source = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const embeddings = JSON.parse(fs.readFileSync('C:/Users/35794/Documents/DeepSeek\'s Sandbox/coopanion-continuity/backups/continuity-tags-20261031/online400/embeddings-1500.json', 'utf8'));
const vectorBySourceTurn = new Map(embeddings.map((row) => [row.turn, row.vector]));
const sizes = [10000, 50000];
const out = [];
for (const size of sizes) {
  const rows = [];
  const vectorMap = new Map();
  for (let index = 0; index < size; index += 1) {
    const base = source[index % source.length];
    const turn = 100000 + index;
    rows.push({ ...base, turn, seqStart: 1000000 + index, seqEnd: 1000000 + index });
    vectorMap.set(turn, vectorBySourceTurn.get(base.turn));
  }
  const buildStart = performance.now();
  const records = buildEventLog(rows);
  const bm25 = new BM25Index().build(records);
  const vectors = new VectorIndex().build(records, vectorMap);
  const buildMs = performance.now() - buildStart;
  const queries = Array.from({ length: 100 }, (_, index) => source[index % source.length]);
  const vectorStart = performance.now();
  for (const row of queries) vectors.search(vectorBySourceTurn.get(row.turn), { topK: 10 });
  const vectorMs = performance.now() - vectorStart;
  const bm25Start = performance.now();
  for (const row of queries) bm25.search(row.text, { topK: 10 });
  const bm25Ms = performance.now() - bm25Start;
  const mem = process.memoryUsage();
  out.push({
    size,
    buildMs: Math.round(buildMs),
    vector100Ms: Math.round(vectorMs),
    vectorMsPerQuery: +(vectorMs / queries.length).toFixed(2),
    bm25100Ms: Math.round(bm25Ms),
    bm25MsPerQuery: +(bm25Ms / queries.length).toFixed(2),
    heapMB: +(mem.heapUsed / 1048576).toFixed(1),
    rssMB: +(mem.rss / 1048576).toFixed(1),
  });
}
fs.writeFileSync(path.join(dir, 'SCALE-DURABLE.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
