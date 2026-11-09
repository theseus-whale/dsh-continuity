import fs from 'node:fs';
import { extractFacets } from '../src/facets/extract.mjs';
import { deserializeClassifier, predictFacets } from '../src/facets/classifier.mjs';
import { deserializePrototypes, predictEmbedding } from '../src/facets/embedding.mjs';

const rows = fs.readFileSync('C:/Users/35794/Documents/DeepSeek\'s Sandbox/coopanion-continuity/backups/continuity-tags-20261031/online400/continuity-1500.jsonl', 'utf8')
  .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.facets && row.text);
const nb = deserializeClassifier(JSON.parse(fs.readFileSync('C:/Users/35794/Documents/DeepSeek\'s Sandbox/coopanion-continuity/backups/continuity-tags-20261031/last100/facet-model.json', 'utf8')));
const prototypes = deserializePrototypes(JSON.parse(fs.readFileSync('C:/Users/35794/Documents/DeepSeek\'s Sandbox/coopanion-continuity/backups/continuity-tags-20261031/last100/facet-prototypes.json', 'utf8')));
const slots = ['activity', 'interaction', 'random', 'participants', 'medium', 'topic'];
const report = { total: rows.length, methods: {} };
for (const [name, method] of [['rule', (text) => extractFacets(text)], ['nb', (text) => predictFacets(nb, text)], ['embedding', async (text) => predictEmbedding(prototypes, text)]]) {
  const stats = Object.fromEntries(slots.map((slot) => [slot, { total: 0, covered: 0, correct: 0 }]));
  let exact = 0;
  for (const row of rows) {
    const prediction = await method(row.text);
    let all = true;
    for (const slot of slots) {
      const truth = row.facets?.[slot];
      if (truth === undefined) { all = false; continue; }
      stats[slot].total += 1;
      const predicted = prediction.facets?.[slot];
      if (predicted === undefined) { all = false; continue; }
      stats[slot].covered += 1;
      if (predicted === truth) stats[slot].correct += 1;
      else all = false;
    }
    if (all) exact += 1;
  }
  for (const slot of slots) {
    const s = stats[slot];
    s.coverage = s.total === 0 ? 0 : Number((s.covered / s.total).toFixed(3));
    s.accuracy = s.covered === 0 ? 0 : Number((s.correct / s.covered).toFixed(3));
  }
  report.methods[name] = { slots: stats, exactFull: Number((exact / rows.length).toFixed(3)) };
}
fs.writeFileSync('C:/Users/35794/Documents/DeepSeek\'s Sandbox/coopanion-continuity/backups/continuity-tags-20261031/durable-memory/build-a/FACET-EVAL-1462.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
