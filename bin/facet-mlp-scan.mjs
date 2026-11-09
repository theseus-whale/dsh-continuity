#!/usr/bin/env node
import fs from 'node:fs';
import { deserializeMlp, predictMlp } from '../src/facets/mlp-probe.mjs';
import { embedTexts } from '../src/facets/embedding.mjs';
import { detectRandom } from '../src/facets/random.mjs';
import { buildFacetIndex, queryFacets, indexStats } from '../src/facets/index.mjs';
import { saveIndex } from '../src/facets/store.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const input = argOf('--input');
const modelPath = argOf('--model');
const dir = argOf('--dir') ?? '.facet-mlp';
const query = argOf('--query') ?? '跑团';
if (!input || !modelPath) {
  console.error('usage: node bin/facet-mlp-scan.mjs --input rows.jsonl --model MLP-MODEL.json --dir .facet --query 跑团');
  process.exit(2);
}
const rows = fs.readFileSync(input, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const model = deserializeMlp(JSON.parse(fs.readFileSync(modelPath, 'utf8')));
const entries = [];
for (const row of rows) {
  const [vector] = await embedTexts([row.text]);
  const result = predictMlp(model, vector);
  result.facets.random = detectRandom(row.text).value;
  if (result.facets.participants === undefined) result.facets.participants = '协作';
  entries.push({
    turn: row.turn,
    seqStart: row.seqStart,
    seqEnd: row.seqEnd,
    facets: result.facets,
    confidence: result.confidence,
  });
}
const index = buildFacetIndex(entries);
fs.mkdirSync(dir, { recursive: true });
saveIndex(`${dir}/facet-index.json`, index);
const result = queryFacets(index, query, { topK: rows.length });
console.log(JSON.stringify({
  stats: indexStats(index),
  query: { name: result.query, facets: result.facets, matches: result.matches.length, ranges: result.ranges },
}, null, 2));
