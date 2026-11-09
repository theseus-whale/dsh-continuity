import fs from 'node:fs';
import { extractFacets } from '../src/facets/extract.mjs';
import { deserializeClassifier, predictFacets } from '../src/facets/classifier.mjs';
import { deserializePrototypes, predictEmbedding } from '../src/facets/embedding.mjs';

const rows = fs.readFileSync('C:/Users/example/Documents/DeepSeek\'s Sandbox/coopanion-continuity/backups/continuity-tags-20261031/online400/continuity-1500.jsonl', 'utf8')
  .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const nb = deserializeClassifier(JSON.parse(fs.readFileSync('C:/Users/example/Documents/DeepSeek\'s Sandbox/coopanion-continuity/backups/continuity-tags-20261031/last100/facet-model.json', 'utf8')));
const prototypes = deserializePrototypes(JSON.parse(fs.readFileSync('C:/Users/example/Documents/DeepSeek\'s Sandbox/coopanion-continuity/backups/continuity-tags-20261031/last100/facet-prototypes.json', 'utf8')));
const turns = [2, 3, 40, 41, 42, 43, 49, 81, 82, 84];
const out = [];
for (const turn of turns) {
  const row = rows.find((item) => Number(item.turn) === turn);
  if (!row) continue;
  const before = Date.now();
  const rule = extractFacets(row.text);
  const ruleMs = Date.now() - before;
  const started = Date.now();
  const nbResult = predictFacets(nb, row.text);
  const nbMs = Date.now() - started;
  const embStarted = Date.now();
  const emb = await predictEmbedding(prototypes, row.text);
  out.push({
    turn,
    truth: row.facets,
    rule: { facets: rule.facets, confidence: rule.confidence, ms: ruleMs },
    nb: { facets: nbResult.facets, confidence: nbResult.confidence, ms: nbMs },
    embedding: { facets: emb.facets, confidence: emb.confidence, ms: Date.now() - embStarted },
    head: String(row.text).replace(/\s+/g, ' ').slice(0, 240),
  });
}
fs.writeFileSync('C:/Users/example/Documents/DeepSeek\'s Sandbox/coopanion-continuity/backups/continuity-tags-20261031/durable-memory/build-a/FACET-ROLEPLAY.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
