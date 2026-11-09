#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { readEventLog } from '../src/memory/event-log.mjs';
import { BM25Index } from '../src/memory/bm25.mjs';
import { VectorIndex } from '../src/memory/vector-index.mjs';
import { buildPlanner, summaryIndex } from '../src/memory/planner.mjs';
import { embedTexts } from '../src/facets/embedding.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = argOf('--dir');
const query = argOf('--query');
const model = argOf('--model');
if (!dir || !query) {
  console.error('usage: node bin/memory-query.mjs --dir .durable-memory --query "..." [--model ...]');
  process.exit(2);
}
const records = readEventLog(path.join(dir, 'events.jsonl'));
const bm25 = BM25Index.fromJSON(JSON.parse(fs.readFileSync(path.join(dir, 'bm25.json'), 'utf8')));
const vectors = VectorIndex.fromJSON(JSON.parse(fs.readFileSync(path.join(dir, 'vectors.json'), 'utf8')));
const tree = JSON.parse(fs.readFileSync(path.join(dir, 'summary-tree.json'), 'utf8'));
const [queryVector] = await embedTexts([query], model);
const planner = buildPlanner({
  records,
  bm25,
  vectorIndex: vectors,
  summaryBm25: summaryIndex(tree),
});
const result = planner.query(query, { queryVector, topK: 10 });
console.log(JSON.stringify({
  query: result.query,
  layers: result.layers,
  facet: result.facet,
  results: result.fused,
}, null, 2));
