import fs from 'node:fs';
import { embedTexts } from '../src/facets/embedding.mjs';
import { createBLabeler } from '../src/memory/bc-label.mjs';
import { makeRecord } from '../src/memory/bc-recall.mjs';
import { loadSpecialKeywords, matchSpecialKeywords } from '../src/memory/special-keywords.mjs';
import { saveIndexJsonl } from '../src/memory/bc-index.mjs';

const source = 'C:/Users/35794/Documents/DeepSeek\'s Sandbox/coopanion-continuity/backups/continuity-tags-20261031/online400/continuity-1500.jsonl';
const target = 'C:/Users/35794/Documents/DeepSeek\'s Sandbox/coopanion-continuity/projects/bc-recall/data/index.jsonl';
const rows = fs.readFileSync(source, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const specialKeywords = loadSpecialKeywords();
const labeler = createBLabeler({ embed: embedTexts });
const records = [];
for (const row of rows) {
  if (!Number.isInteger(row.turn) || !Number.isInteger(row.seqStart)) continue;
  const label = await labeler.label(row.text, { topK: 3, minScore: 0.25 });
  const generic = label.candidates.map((candidate) => candidate.concept);
  const conceptScores = Object.fromEntries(label.candidates.map((candidate) => [candidate.concept, candidate.score]));
  const terms = [];
  if (row.facets?.activity === '跑团') terms.push('跑团');
  if (/COVID|实验室泄漏|自然宿主|冷链传播/.test(row.text)) terms.push('COVID-19');
  records.push(makeRecord({
    turn: row.turn,
    seqStart: row.seqStart,
    seqEnd: row.seqEnd,
    generic,
    terms,
    keywords: matchSpecialKeywords(row.text, specialKeywords),
    conceptScores,
    confidence: label.top?.score ?? 0,
    status: 'weak',
  }));
}
saveIndexJsonl(target, records);
console.log(JSON.stringify({ source, target, rows: rows.length, records: records.length }, null, 2));
