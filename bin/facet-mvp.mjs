#!/usr/bin/env node
/**
 * Facet MVP CLI.
 *
 * Input JSONL rows: { turn, seqStart, seqEnd, text? , facets? }
 * Builds a facet index, prints stats, and runs one alias query.
 */
import fs from 'node:fs';
import { buildFacetIndex, indexStats, queryFacets } from '../src/facets/index.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const input = argOf('--input');
const query = argOf('--query') ?? '跑团';
const topK = Number(argOf('--top')) || 20;
if (!input) {
  console.error('usage: node bin/facet-mvp.mjs --input rows.jsonl --query 跑团 [--top 20]');
  process.exit(2);
}
const rows = fs.readFileSync(input, 'utf8')
  .split(/\r?\n/).filter(Boolean)
  .map((line) => JSON.parse(line));
const index = buildFacetIndex(rows);
const result = queryFacets(index, query, { topK });
console.log(JSON.stringify({
  stats: indexStats(index),
  query: { name: result.query, facets: result.facets },
  matchCount: result.matches.length,
  ranges: result.ranges,
  top: result.matches.slice(0, Math.min(10, topK)),
}, null, 2));
