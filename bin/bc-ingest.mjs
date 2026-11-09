import fs from 'node:fs';
import { embedTexts } from '../src/facets/embedding.mjs';
import { createBLabeler } from '../src/memory/bc-label.mjs';
import { makeRecord } from '../src/memory/bc-recall.mjs';
import { emptyStore, saveBCStore } from '../src/memory/bc-store.mjs';

const source = process.argv[2] ?? 'C:/Users/35794/Documents/DeepSeek\'s Sandbox/coopanion-continuity/backups/continuity-tags-20261031/online400/continuity-1500.jsonl';
const target = process.argv[3] ?? 'C:/Users/35794/Documents/DeepSeek\'s Sandbox/coopanion-continuity/projects/bc-recall/data/store.json';
const rows = fs.readFileSync(source, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  .filter((row) => row.facets?.activity === '跑团');
const labeler = createBLabeler({ embed: embedTexts });
const store = emptyStore();
for (const row of rows) {
  const label = await labeler.label(row.text, { topK: 3, minScore: 0.25 });
  const generic = label.candidates.map((candidate) => candidate.concept);
  const conceptScores = Object.fromEntries(label.candidates.map((candidate) => [candidate.concept, candidate.score]));
  const terms = ['跑团'];
  store.records.push(makeRecord({
    turn: row.turn,
    seqStart: row.seqStart,
    seqEnd: row.seqEnd,
    text: row.text,
    generic,
    terms,
    confidence: label.top?.score ?? 0,
    conceptScores,
    status: 'weak',
  }));
}
saveBCStore(target, store);
console.log(JSON.stringify({ source, target, records: store.records.length, sample: store.records.slice(0, 3) }, null, 2));
