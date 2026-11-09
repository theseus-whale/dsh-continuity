#!/usr/bin/env node
import fs from 'node:fs';
import { buildFacetIndex } from '../src/facets/index.mjs';
import { buildFacetPanel } from '../src/facets/panel.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const input = argOf('--input');
const out = argOf('--out');
const alias = argOf('--alias') ?? '跑团';
if (!input || !out) {
  console.error('usage: node bin/facet-panel.mjs --input rows.jsonl --out facet-panel.json --alias 跑团');
  process.exit(2);
}
const rows = fs.readFileSync(input, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const index = buildFacetIndex(rows);
const panel = buildFacetPanel(index.entries, { idf: index.idf, currentAlias: alias });
fs.writeFileSync(out, `${JSON.stringify(panel, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ out, total: panel.totalTurns, facetSum: panel.facetSum, currentTopic: panel.currentTopic?.alias }, null, 2));
