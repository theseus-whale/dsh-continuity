#!/usr/bin/env node
/**
 * Embedding holdout validation.
 *
 * node bin/facet-embedding-validate.mjs --input rows.jsonl
 *
 * Requires @huggingface/transformers and a first-run model download (local
 * cache afterwards). No text leaves the machine after the model is cached.
 */
import fs from 'node:fs';
import { buildEmbeddingPrototypes, predictEmbedding } from '../src/facets/embedding.mjs';
import { trainFacetClassifier } from '../src/facets/classifier.mjs';
import { hybridExtractor } from '../src/facets/hybrid.mjs';
import { SLOTS, normalizeFacets } from '../src/facets/schema.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const input = argOf('--input');
const model = argOf('--model') ?? 'Xenova/bge-small-zh-v1.5';
if (!input) {
  console.error('usage: node bin/facet-embedding-validate.mjs --input rows.jsonl [--model ...]');
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

const prototypes = await buildEmbeddingPrototypes(train, model);
const fallback = hybridExtractor(trainFacetClassifier(train));

function emptyReport() {
  return Object.fromEntries(SLOTS.map((slot) => [slot, { total: 0, covered: 0, correct: 0 }]));
}
const embedReport = emptyReport();
const mergedReport = emptyReport();
for (const row of test) {
  const truth = normalizeFacets(row.facets ?? {});
  const embedded = await predictEmbedding(prototypes, row.text, model);
  const merged = fallback(row.text);
  for (const slot of SLOTS) {
    if (truth[slot] === undefined) continue;
    embedReport[slot].total += 1;
    mergedReport[slot].total += 1;
    if (embedded.facets[slot] !== undefined) {
      embedReport[slot].covered += 1;
      if (embedded.facets[slot] === truth[slot]) embedReport[slot].correct += 1;
    }
    const predicted = embedded.facets[slot] ?? merged.facets[slot];
    if (predicted !== undefined) {
      mergedReport[slot].covered += 1;
      if (predicted === truth[slot]) mergedReport[slot].correct += 1;
    }
  }
}

function finish(report) {
  return Object.fromEntries(Object.entries(report).map(([slot, value]) => [slot, {
    ...value,
    coverage: value.total === 0 ? 0 : value.covered / value.total,
    accuracy: value.covered === 0 ? 0 : value.correct / value.covered,
  }]));
}

console.log(JSON.stringify({
  model,
  split: { train: train.length, test: test.length },
  embeddingOnly: finish(embedReport),
  embeddingWithNBFallback: finish(mergedReport),
}, null, 2));
