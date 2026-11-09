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
if (!dir) {
  console.error('usage: node bin/memory-bench.mjs --dir .durable-memory');
  process.exit(2);
}
const records = readEventLog(path.join(dir, 'events.jsonl'));
const bm25 = BM25Index.fromJSON(JSON.parse(fs.readFileSync(path.join(dir, 'bm25.json'), 'utf8')));
const vectors = VectorIndex.fromJSON(JSON.parse(fs.readFileSync(path.join(dir, 'vectors.json'), 'utf8')));
const tree = JSON.parse(fs.readFileSync(path.join(dir, 'summary-tree.json'), 'utf8'));
const planner = buildPlanner({ records, bm25, vectorIndex: vectors, summaryBm25: summaryIndex(tree) });
const set = JSON.parse(fs.readFileSync(path.join(dir, 'QUERY-SET.json'), 'utf8'));
const rows = [];
for (const testCase of set.cases) {
  const expected = new Set(testCase.expected);
  const [queryVector] = await embedTexts([testCase.query]);
  const plan = planner.query(testCase.query, { queryVector, topK: 10 });
  const got = plan.fused.map((hit) => hit.turn);
  const top = got.slice(0, 10);
  const tp = top.filter((turn) => expected.has(turn)).length;
  rows.push({
    query: testCase.query,
    route: plan.route,
    expected: expected.size,
    returned: top.length,
    hits: tp,
    precision: top.length === 0 ? 0 : tp / top.length,
    recall: expected.size === 0 ? (top.length === 0 ? 1 : 0) : tp / expected.size,
    top: top.slice(0, 5),
  });
}
const aggregate = {
  precision: rows.reduce((sum, row) => sum + row.precision, 0) / rows.length,
  recall: rows.reduce((sum, row) => sum + row.recall, 0) / rows.length,
  emptyCorrect: rows.filter((row) => row.expected === 0 && row.returned === 0).length,
  emptyQueries: rows.filter((row) => row.expected === 0).length,
};
const output = { dir, set: set.provenance, aggregate, rows };
fs.writeFileSync(path.join(dir, 'QUERY-BENCH.json'), JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
