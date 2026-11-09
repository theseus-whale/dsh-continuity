#!/usr/bin/env node
/**
 * Prequential validation: predict turn t from turns < t, then learn t.
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
const model = argOf('--model') ?? 'Xenova/bge-small-zh-v1.5';
if (!input) {
  console.error('usage: node bin/facet-online-validate.mjs --input early50-labeled.jsonl');
  process.exit(2);
}
const rows = fs.readFileSync(input, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const vectors = await embedTexts(rows.map((row) => row.text), model);
const learner = new OnlineFacetKnn({ k: 5, minSimilarity: 0.15, minVote: 0.5 });
const report = {};
for (const slot of SLOTS) report[slot] = { total: 0, covered: 0, correct: 0 };
let unknownTurns = 0;
const timeline = [];
for (let index = 0; index < rows.length; index += 1) {
  const row = rows[index];
  const truth = normalizeFacets(row.facets ?? {});
  const predicted = learner.predict(vectors[index]);
  if (predicted.unknown) unknownTurns += 1;
  predicted.facets.random = detectRandom(row.text).value;
  const entry = { turn: row.turn, unknown: predicted.unknown, facets: predicted.facets };
  timeline.push(entry);
  for (const slot of SLOTS) {
    if (truth[slot] === undefined) continue;
    report[slot].total += 1;
    if (predicted.facets[slot] === undefined) continue;
    report[slot].covered += 1;
    if (predicted.facets[slot] === truth[slot]) report[slot].correct += 1;
  }
  learner.add(vectors[index], truth);
}
for (const slot of SLOTS) {
  const row = report[slot];
  row.coverage = row.total === 0 ? 0 : row.covered / row.total;
  row.accuracy = row.covered === 0 ? 0 : row.correct / row.covered;
}
console.log(JSON.stringify({ rows: rows.length, unknownTurns, report, timeline }, null, 2));
