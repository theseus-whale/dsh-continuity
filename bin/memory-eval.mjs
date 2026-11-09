#!/usr/bin/env node
/**
 * Retrieval ablation: facet / BM25 / vector / summary / routed planner.
 * Ground truth is the weak facet label or an explicit text predicate.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readEventLog } from '../src/memory/event-log.mjs';
import { BM25Index } from '../src/memory/bm25.mjs';
import { VectorIndex } from '../src/memory/vector-index.mjs';
import { buildPlanner, summaryIndex } from '../src/memory/planner.mjs';
import { buildFacetIndex, queryFacets } from '../src/facets/index.mjs';
import { aliasFacets } from '../src/facets/schema.mjs';
import { embedTexts } from '../src/facets/embedding.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = argOf('--dir');
if (!dir) {
  console.error('usage: node bin/memory-eval.mjs --dir .durable-memory');
  process.exit(2);
}
const records = readEventLog(path.join(dir, 'events.jsonl'));
const bm25 = BM25Index.fromJSON(JSON.parse(fs.readFileSync(path.join(dir, 'bm25.json'), 'utf8')));
const vectors = VectorIndex.fromJSON(JSON.parse(fs.readFileSync(path.join(dir, 'vectors.json'), 'utf8')));
const tree = JSON.parse(fs.readFileSync(path.join(dir, 'summary-tree.json'), 'utf8'));
const facetIndex = buildFacetIndex(records);
const summaries = summaryIndex(tree);
const planner = buildPlanner({ records, bm25, vectorIndex: vectors, summaryBm25: summaries });

const cases = [];
for (const [query, core] of [
  ['跑团', { activity: '跑团' }],
  ['开发', { activity: '开发' }],
  ['调试', { activity: '调试' }],
  ['记忆', { topic: '记忆' }],
  ['规则', { topic: '规则' }],
  ['图像', { topic: '设备', medium: '图像' }],
  ['技术', { topic: '技术' }],
]) {
  cases.push({
    query,
    expected: new Set(records.filter((record) => Object.entries(core).every(([key, value]) => record.facets[key] === value)).map((record) => record.turn)),
  });
}
cases.push({
  query: 'd100 钥匙',
  expected: new Set(records.filter((record) => record.facets.activity === '跑团' && /d100|钥匙/.test(record.text)).map((record) => record.turn)),
});
cases.push({
  query: 'TAG 闸',
  expected: new Set(records.filter((record) => /TAG|打标/.test(record.text) && /闸/.test(record.text)).map((record) => record.turn)),
});
cases.push({ query: '量子计算', expected: new Set() });

function rankMetrics(got, expected) {
  const top = got.slice(0, 10);
  const tp = top.filter((turn) => expected.has(turn)).length;
  return {
    precision: top.length === 0 ? 0 : tp / top.length,
    recall: expected.size === 0 ? (top.length === 0 ? 1 : 0) : tp / expected.size,
    hits: tp,
    returned: top.length,
    expected: expected.size,
  };
}

const rows = [];
for (const testCase of cases) {
  const [queryVector] = await embedTexts([testCase.query]);
  const alias = aliasFacets(testCase.query);
  const facet = Object.keys(alias).length > 0
    ? queryFacets(facetIndex, testCase.query, { topK: 10 }).matches.map((hit) => hit.turn)
    : [];
  const keyword = bm25.search(testCase.query, { topK: 10, minCoverage: 0.6 }).map((hit) => hit.turn);
  const semantic = vectors.search(queryVector, { topK: 10 }).map((hit) => hit.turn);
  const summary = summaries.search(testCase.query, { topK: 5, minCoverage: 0.5 }).map((hit) => hit.turn);
  const plan = planner.query(testCase.query, { queryVector, topK: 10 });
  const hybrid = plan.fused.map((hit) => hit.turn);
  rows.push({
    query: testCase.query,
    route: plan.route,
    expected: testCase.expected.size,
    facet: rankMetrics(facet, testCase.expected),
    bm25: rankMetrics(keyword, testCase.expected),
    vector: rankMetrics(semantic, testCase.expected),
    summary: rankMetrics(summary, testCase.expected),
    hybrid: rankMetrics(hybrid, testCase.expected),
  });
}

const aggregate = {};
for (const layer of ['facet', 'bm25', 'vector', 'summary', 'hybrid']) {
  aggregate[layer] = {
    precision: rows.reduce((sum, row) => sum + row[layer].precision, 0) / rows.length,
    recall: rows.reduce((sum, row) => sum + row[layer].recall, 0) / rows.length,
  };
}
const output = { dir, cases: rows, aggregate };
fs.writeFileSync(path.join(dir, 'RETRIEVAL-ABLATION.json'), JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
