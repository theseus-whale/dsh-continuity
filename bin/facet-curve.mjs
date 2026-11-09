#!/usr/bin/env node
/**
 * Facet sensitivity CLI: rows with facets -> weighted temporal curve.
 */
import fs from 'node:fs';
import { buildFacetIndex } from '../src/facets/index.mjs';
import { sensitivitySeries } from '../src/facets/sensitivity.mjs';
import { aliasFacets } from '../src/facets/schema.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const input = argOf('--input');
const query = argOf('--query') ?? '跑团';
if (!input) {
  console.error('usage: node bin/facet-curve.mjs --input rows.jsonl --query 跑团 [--out series.json]');
  process.exit(2);
}
const rows = fs.readFileSync(input, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const index = buildFacetIndex(rows);
const series = sensitivitySeries(index.entries, aliasFacets(query), { idf: index.idf });
const out = argOf('--out');
const text = JSON.stringify({ query, facets: aliasFacets(query), series }, null, 2);
if (out) fs.writeFileSync(out, `${text}\n`, 'utf8');
else console.log(text);
