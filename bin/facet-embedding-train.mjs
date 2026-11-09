#!/usr/bin/env node
import fs from 'node:fs';
import { buildEmbeddingPrototypes, serializePrototypes } from '../src/facets/embedding.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const input = argOf('--input');
const out = argOf('--out') ?? 'facet-prototypes.json';
const model = argOf('--model') ?? 'Xenova/bge-small-zh-v1.5';
if (!input) {
  console.error('usage: node bin/facet-embedding-train.mjs --input rows.jsonl --out facet-prototypes.json');
  process.exit(2);
}
const rows = fs.readFileSync(input, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const prototypes = await buildEmbeddingPrototypes(rows, model);
fs.writeFileSync(out, `${JSON.stringify(serializePrototypes(prototypes))}\n`, 'utf8');
console.log(JSON.stringify({ input: rows.length, out, model }, null, 2));
