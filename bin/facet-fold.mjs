#!/usr/bin/env node
import fs from 'node:fs';
import { buildFacetIndex } from '../src/facets/index.mjs';
import { aliasFacets } from '../src/facets/schema.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const input = argOf('--input');
const out = argOf('--out');
const query = argOf('--query') ?? '跑团';
if (!input || !out) {
  console.error('usage: node bin/facet-fold.mjs --input rows.jsonl --out facet-fold.json --query 跑团');
  process.exit(2);
}
const rows = fs.readFileSync(input, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const index = buildFacetIndex(rows);
const payload = {
  query: aliasFacets(query),
  idf: [...index.idf.entries()],
  entries: index.entries.map((entry) => ({
    turn: entry.turn,
    seqStart: entry.seqStart,
    seqEnd: entry.seqEnd,
    facets: entry.facets,
  })),
};
fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ out, query, entries: payload.entries.length }, null, 2));
