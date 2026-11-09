import fs from 'node:fs';
import { deserializePrototypes, predictEmbedding } from '../src/facets/embedding.mjs';
import { extractFacets } from '../src/facets/extract.mjs';

const text = '我昨天看了COVID-19的起源报告，病毒可能来自实验室泄漏，也提到自然宿主和冷链传播。';
const prototypes = deserializePrototypes(JSON.parse(fs.readFileSync('C:/Users/example/Documents/DeepSeek\'s Sandbox/coopanion-continuity/backups/continuity-tags-20261031/last100/facet-prototypes.json', 'utf8')));
const result = await predictEmbedding(prototypes, text);
console.log(JSON.stringify({ text, rule: extractFacets(text), embedding: result }, null, 2));
