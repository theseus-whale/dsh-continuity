#!/usr/bin/env node
/**
 * Offline dry run: query -> planner -> seq ranges -> simulated load.
 * No live session and no writes.
 */
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
  console.error('usage: node bin/memory-dry-run.mjs --dir .durable-memory');
  process.exit(2);
}
const records = readEventLog(path.join(dir, 'events.jsonl'));
const byTurn = new Map(records.map((record) => [record.turn, record]));
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
  const ranges = [];
  const loaded = [];
  for (const hit of plan.fused.slice(0, 10)) {
    const record = byTurn.get(hit.turn);
    if (record === undefined) {
      ranges.push({ turn: hit.turn, valid: false });
      continue;
    }
    ranges.push({ turn: hit.turn, seqStart: record.seqStart, seqEnd: record.seqEnd, valid: true });
    loaded.push(record);
  }
  const text = loaded.map((record) => record.text).join('\n');
  const hitTurns = loaded.map((record) => record.turn).filter((turn) => expected.has(turn));
  rows.push({
    query: testCase.query,
    route: plan.route,
    expected: expected.size,
    loadedTurns: loaded.length,
    expectedHits: hitTurns.length,
    allRangesValid: ranges.every((range) => range.valid),
    chars: text.length,
    ranges,
  });
}
const summary = {
  queries: rows.length,
  allRangesValid: rows.every((row) => row.allRangesValid),
  expectedHitQueries: rows.filter((row) => row.expected === 0 || row.expectedHits > 0).length,
  emptyCorrect: rows.filter((row) => row.expected === 0 && row.loadedTurns === 0).length,
  emptyQueries: rows.filter((row) => row.expected === 0).length,
};
const output = { dir, summary, rows };
fs.writeFileSync(path.join(dir, 'DRY-RUN.json'), JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
