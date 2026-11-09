#!/usr/bin/env node
import { loadFacetQuery } from '../src/facets/load.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const query = argOf('--query') ?? '跑团';
const indexFile = argOf('--index');
if (!indexFile) {
  console.error('usage: node bin/facet-load.mjs --index facet-index.json --query 跑团 [--top 20]');
  process.exit(2);
}
const topK = Number(argOf('--top') ?? 20);
console.log(JSON.stringify(loadFacetQuery(query, { indexFile, topK }), null, 2));
