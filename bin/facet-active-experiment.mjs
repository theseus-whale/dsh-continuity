#!/usr/bin/env node
/**
 * Active-learning label-efficiency experiment.
 *
 * Select 10 labels from a train pool (no test leakage), compare random vs
 * uncertainty selection, then evaluate the untouched test pool.
 */
import fs from 'node:fs';
import { embedTexts } from '../src/facets/embedding.mjs';
import { OnlineFacetKnn } from '../src/facets/online-knn.mjs';
import { detectRandom } from '../src/facets/random.mjs';
import { SLOTS, normalizeFacets } from '../src/facets/schema.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const input = argOf('--input');
if (!input) {
  console.error('usage: node bin/facet-active-experiment.mjs --input early50-labeled.jsonl');
  process.exit(2);
}
const rows = fs.readFileSync(input, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const vectors = await embedTexts(rows.map((row) => row.text));

const groups = new Map();
for (const row of rows) {
  const activity = normalizeFacets(row.facets).activity ?? '其他';
  if (!groups.has(activity)) groups.set(activity, []);
  groups.get(activity).push(row);
}
const train = [];
const test = [];
for (const list of groups.values()) {
  list.sort((a, b) => a.turn - b.turn);
  list.forEach((row, index) => (index % 2 === 0 ? train : test).push(row));
}
const vectorOf = new Map(rows.map((row, index) => [row.turn, vectors[index]]));

function makeLearner(selected) {
  const learner = new OnlineFacetKnn({ k: 5, minSimilarity: 0.15, minVote: 0.5 });
  for (const row of selected) learner.add(vectorOf.get(row.turn), row.facets);
  return learner;
}

function evaluate(selected) {
  const learner = makeLearner(selected);
  const report = Object.fromEntries(SLOTS.map((slot) => [slot, { total: 0, covered: 0, correct: 0 }]));
  for (const row of test) {
    const truth = normalizeFacets(row.facets ?? {});
    const predicted = learner.predict(vectorOf.get(row.turn));
    predicted.facets.random = detectRandom(row.text).value;
    for (const slot of SLOTS) {
      if (truth[slot] === undefined) continue;
      report[slot].total += 1;
      if (predicted.facets[slot] === undefined) continue;
      report[slot].covered += 1;
      if (predicted.facets[slot] === truth[slot]) report[slot].correct += 1;
    }
  }
  for (const slot of SLOTS) {
    const row = report[slot];
    row.coverage = row.total === 0 ? 0 : row.covered / row.total;
    row.accuracy = row.covered === 0 ? 0 : row.correct / row.covered;
  }
  return report;
}

function uncertainty(learner, vector) {
  const predicted = learner.predict(vector);
  const slots = ['activity', 'topic'];
  let sum = 0;
  for (const slot of slots) {
    const confidence = predicted.confidence?.[slot];
    sum += confidence === undefined ? 1 : 1 - confidence;
  }
  return sum / slots.length;
}

function activeSelect(seedCount, budget) {
  const selected = [...train.slice(0, seedCount)];
  const pool = train.slice(seedCount);
  while (selected.length < budget && pool.length > 0) {
    const learner = makeLearner(selected);
    let bestIndex = 0;
    let best = -1;
    pool.forEach((row, index) => {
      const score = uncertainty(learner, vectorOf.get(row.turn));
      if (score > best) { best = score; bestIndex = index; }
    });
    selected.push(pool.splice(bestIndex, 1)[0]);
  }
  return selected;
}

function randomSelect(seedCount, budget) {
  return train.slice(0, Math.min(budget, train.length));
}

const result = {
  full: evaluate(train),
  random10: evaluate(randomSelect(2, 10)),
  active10: evaluate(activeSelect(2, 10)),
  random20: evaluate(randomSelect(2, 20)),
  active20: evaluate(activeSelect(2, 20)),
};
fs.writeFileSync(`${input}.active-experiment.json`, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
const summary = Object.fromEntries(Object.entries(result).map(([name, report]) => [name, Object.fromEntries(Object.entries(report).map(([slot, row]) => [slot, `${(row.accuracy * 100).toFixed(1)}% @ ${(row.coverage * 100).toFixed(1)}%`]))]));
console.log(JSON.stringify(summary, null, 2));
