#!/usr/bin/env node
import fs from 'node:fs';
import { trainFacetClassifier, evaluate, serializeClassifier } from '../src/facets/classifier.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const input = argOf('--input');
const out = argOf('--out') ?? 'facet-model.json';
if (!input) {
  console.error('usage: node bin/facet-train.mjs --input rows.jsonl --out facet-model.json');
  process.exit(2);
}
const rows = fs.readFileSync(input, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const model = trainFacetClassifier(rows);
fs.writeFileSync(out, `${JSON.stringify(serializeClassifier(model))}\n`, 'utf8');
console.log(JSON.stringify({ input: rows.length, out, report: evaluate(model, rows) }, null, 2));
