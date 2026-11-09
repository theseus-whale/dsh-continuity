#!/usr/bin/env node
import fs from 'node:fs';
import { embedTexts } from '../src/facets/embedding.mjs';
import { OnlineFacetKnn } from '../src/facets/online-knn.mjs';
import { seedRows } from '../src/facets/seed-examples.mjs';
import { detectRandom } from '../src/facets/random.mjs';
import { SLOTS, normalizeFacets } from '../src/facets/schema.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const input = argOf('--input');
if (!input) {
  console.error('usage: node bin/facet-online-experiments.mjs --input early50-labeled.jsonl');
  process.exit(2);
}
const rows = fs.readFileSync(input, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const vectors = await embedTexts(rows.map((row) => row.text));
const seedData = seedRows();
const seedVectors = await embedTexts(seedData.map((row) => row.text));

function makeLearner(useSeeds) {
  const learner = new OnlineFacetKnn({ k: 5, minSimilarity: 0.15, minVote: 0.5 });
  if (useSeeds) seedData.forEach((row, index) => learner.add(seedVectors[index], row.facets));
  return learner;
}

function evaluate({ useSeeds = false, warm = 0, temporal = false } = {}) {
  const learner = makeLearner(useSeeds);
  const report = Object.fromEntries(SLOTS.map((slot) => [slot, { total: 0, covered: 0, correct: 0 }]));
  const timeline = [];
  let previous = {};
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const truth = normalizeFacets(row.facets ?? {});
    if (index >= warm) {
      const predicted = learner.predict(vectors[index]);
      if (temporal) {
        for (const slot of SLOTS) {
          if (predicted.facets[slot] === undefined && previous[slot] !== undefined) {
            predicted.facets[slot] = previous[slot];
          }
        }
      }
      predicted.facets.random = detectRandom(row.text).value;
      previous = { ...predicted.facets };
      timeline.push({ turn: row.turn, facets: predicted.facets, unknown: predicted.unknown });
      for (const slot of SLOTS) {
        if (truth[slot] === undefined) continue;
        report[slot].total += 1;
        if (predicted.facets[slot] === undefined) continue;
        report[slot].covered += 1;
        if (predicted.facets[slot] === truth[slot]) report[slot].correct += 1;
      }
    }
    learner.add(vectors[index], truth);
  }
  for (const slot of SLOTS) {
    const row = report[slot];
    row.coverage = row.total === 0 ? 0 : row.covered / row.total;
    row.accuracy = row.covered === 0 ? 0 : row.correct / row.covered;
  }
  return { report, timeline };
}

const result = {
  baseline: evaluate(),
  schemaSeeds: evaluate({ useSeeds: true }),
  warm10: evaluate({ warm: 10 }),
  warm10Seeds: evaluate({ useSeeds: true, warm: 10 }),
  warm10Temporal: evaluate({ warm: 10, temporal: true }),
};
fs.writeFileSync(`${input}.online-experiments.json`, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
const out = Object.fromEntries(Object.entries(result).map(([name, value]) => [name, Object.fromEntries(Object.entries(value.report).map(([slot, row]) => [slot, `${(row.accuracy * 100).toFixed(1)}% @ ${(row.coverage * 100).toFixed(1)}%`]))]));
console.log(JSON.stringify(out, null, 2));

