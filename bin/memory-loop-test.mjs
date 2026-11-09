#!/usr/bin/env node
/**
 * Real-data checkpoint loop: 50 / 200 / 800 / 1500 turns.
 * Simulates "上次的 X 怎么样了" and records route, load size, future leaks,
 * latest-hit correctness, noise and misses.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEventLog } from '../src/memory/event-log.mjs';
import { BM25Index } from '../src/memory/bm25.mjs';
import { VectorIndex } from '../src/memory/vector-index.mjs';
import { buildSummaryTree } from '../src/memory/summary-tree.mjs';
import { buildPlanner, summaryIndex } from '../src/memory/planner.mjs';
import { embedTexts } from '../src/facets/embedding.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = argOf('--dir') ?? process.env.CONTINUITY_FIXTURE_DIR ?? path.join(os.homedir(), 'continuity-fixtures', 'durable-memory', 'build-a');
const records = readEventLog(path.join(dir, 'events.jsonl'));
const embeddingsFile = process.env.CONTINUITY_EMBEDDINGS ?? path.join(dir, '..', '..', 'online400', 'embeddings-1500.json');
const embeddings = JSON.parse(fs.readFileSync(embeddingsFile, 'utf8'));
const vectorByTurn = new Map(embeddings.map((row) => [row.turn, row.vector]));
const cases = [
  ['上次的跑团怎么样了', (r) => r.facets.activity === '跑团'],
  ['上次的TAG闸是什么', (r) => /tag/i.test(r.text) && /闸/.test(r.text)],
  ['上次的头像呢', (r) => r.facets.medium === '图像'],
  ['上次的上下文折叠', (r) => /上下文/.test(r.text) && /折叠/.test(r.text)],
  ['上次手抖是哪轮', (r) => /手抖/.test(r.text)],
  ['上次的灯室', (r) => /灯室/.test(r.text)],
  ['上次 沈砚 七把钥匙', (r) => /沈砚/.test(r.text) && /七把钥匙/.test(r.text)],
  ['上次 dsh-continuity-0.1.0.tgz', (r) => /dsh-continuity-0\.1\.0\.tgz/.test(r.text)],
  ['上次 C v5', (r) => /C v5/.test(r.text)],
  ['上次量子计算', () => false],
];
const queryVectors = new Map();
for (const [query] of cases) {
  const [vector] = await embedTexts([query]);
  queryVectors.set(query, vector);
}
const checkpoints = [50, 200, 800, 1500];
const output = [];
for (const checkpoint of checkpoints) {
  const visible = records.filter((record) => record.turn <= checkpoint);
  const bm25 = new BM25Index().build(visible);
  const vectors = new VectorIndex().build(visible, vectorByTurn);
  const tree = buildSummaryTree(visible);
  const planner = buildPlanner({ records: visible, bm25, vectorIndex: vectors, summaryBm25: summaryIndex(tree) });
  const rows = [];
  for (const [query, predicate] of cases) {
    const expected = visible.filter(predicate).map((record) => record.turn);
    const expectedSet = new Set(expected);
    const plan = planner.query(query, { queryVector: queryVectors.get(query), topK: 10, asOf: checkpoint });
    const loaded = plan.fused.map((hit) => visible.find((record) => record.turn === hit.turn)).filter(Boolean);
    const turns = loaded.map((record) => record.turn);
    const expectedHits = turns.filter((turn) => expectedSet.has(turn));
    const futureLeak = turns.filter((turn) => turn > checkpoint);
    const latestExpected = expected.length === 0 ? null : Math.max(...expected);
    rows.push({
      query,
      route: plan.route,
      expected: expected.length,
      latestExpected,
      returned: turns.length,
      expectedHits: expectedHits.length,
      latestHit: latestExpected === null ? null : turns.includes(latestExpected),
      futureLeak: futureLeak.length,
      noise: turns.length - expectedHits.length,
      chars: loaded.reduce((sum, record) => sum + record.text.length, 0),
      top: turns.slice(0, 5),
    });
  }
  output.push({ checkpoint, visible: visible.length, rows });
}
const summary = {
  checkpoints: output.map((entry) => ({
    checkpoint: entry.checkpoint,
    visible: entry.visible,
    futureLeaks: entry.rows.reduce((sum, row) => sum + row.futureLeak, 0),
    latestMiss: entry.rows.filter((row) => row.latestHit === false).map((row) => row.query),
    emptyFalse: entry.rows.filter((row) => row.expected === 0 && row.returned > 0).map((row) => row.query),
    misses: entry.rows.filter((row) => row.expected > 0 && row.expectedHits === 0).map((row) => row.query),
    noise: entry.rows.reduce((sum, row) => sum + row.noise, 0),
    chars: entry.rows.reduce((sum, row) => sum + row.chars, 0),
  })),
};
const result = { summary, output };
fs.writeFileSync(path.join(dir, 'LOOP-CHECKPOINTS.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(summary, null, 2));
