#!/usr/bin/env node
/**
 * Closed-loop validation:
 * stratified holdout -> train local NB -> hybrid extract -> index -> alias query.
 *
 * Input rows: { turn, seqStart, seqEnd, text, facets }
 * `facets` is the accepted model label used only for training/evaluation.
 */
import fs from 'node:fs';
import { trainFacetClassifier } from '../src/facets/classifier.mjs';
import { hybridExtractor } from '../src/facets/hybrid.mjs';
import { buildFacetIndex, queryFacets, indexStats } from '../src/facets/index.mjs';
import { SLOTS, normalizeFacets } from '../src/facets/schema.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const input = argOf('--input');
const query = argOf('--query') ?? '跑团';
if (!input) {
  console.error('usage: node bin/facet-validate.mjs --input rows.jsonl [--query 跑团]');
  process.exit(2);
}
const rows = fs.readFileSync(input, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));

const groups = new Map();
for (const row of rows) {
  const activity = normalizeFacets(row.facets ?? {}).activity ?? '其他';
  if (!groups.has(activity)) groups.set(activity, []);
  groups.get(activity).push(row);
}
const train = [];
const test = [];
for (const list of groups.values()) {
  list.sort((a, b) => a.turn - b.turn);
  list.forEach((row, index) => (index % 2 === 0 ? train : test).push(row));
}

const model = trainFacetClassifier(train);
const extract = hybridExtractor(model);

function evaluate(rowsToTest) {
  const report = {};
  for (const slot of SLOTS) {
    let total = 0;
    let correct = 0;
    let covered = 0;
    for (const row of rowsToTest) {
      const truth = normalizeFacets(row.facets ?? {})[slot];
      if (truth === undefined) continue;
      total += 1;
      const predicted = extract(row.text).facets[slot];
      if (predicted === undefined) continue;
      covered += 1;
      if (predicted === truth) correct += 1;
    }
    report[slot] = {
      total,
      covered,
      correct,
      coverage: total === 0 ? 0 : covered / total,
      accuracy: covered === 0 ? 0 : correct / covered,
    };
  }
  return report;
}

const testRows = test.map((row) => ({
  turn: row.turn,
  seqStart: row.seqStart,
  seqEnd: row.seqEnd,
  text: row.text,
}));
const index = buildFacetIndex(testRows, { extract });
const result = queryFacets(index, query, { topK: testRows.length, minCoverage: 0.6 });
const truthRun = new Set(test
  .filter((row) => normalizeFacets(row.facets ?? {}).activity === '跑团')
  .map((row) => row.turn));
const foundRun = new Set(result.matches
  .filter((hit) => truthRun.has(hit.turn) || true)
  .map((hit) => hit.turn)
  .filter((turn) => truthRun.has(turn)));
const truePositive = result.matches.filter((hit) => truthRun.has(hit.turn)).length;
const precision = result.matches.length === 0 ? 0 : truePositive / result.matches.length;
const recall = truthRun.size === 0 ? 0 : truePositive / truthRun.size;

console.log(JSON.stringify({
  split: { train: train.length, test: test.length },
  accuracy: evaluate(test),
  index: indexStats(index),
  query: {
    name: result.query,
    facets: result.facets,
    matches: result.matches.length,
    truthRun: truthRun.size,
    truePositive,
    precision,
    recall,
    ranges: result.ranges,
  },
}, null, 2));
