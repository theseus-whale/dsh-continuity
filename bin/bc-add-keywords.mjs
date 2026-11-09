import fs from 'node:fs';
import { extractKeywords } from '../src/memory/bc-recall.mjs';
import { loadSpecialKeywords, matchSpecialKeywords } from '../src/memory/special-keywords.mjs';
import { loadIndexJsonl, saveIndexJsonl } from '../src/memory/bc-index.mjs';

const root = 'C:/Users/35794/Documents/DeepSeek\'s Sandbox/coopanion-continuity';
const indexFile = `${root}/projects/bc-recall/data/index.jsonl`;
const sourceFile = `${root}/backups/continuity-tags-20261031/online400/continuity-1500.jsonl`;
const records = loadIndexJsonl(indexFile);
const rows = fs.readFileSync(sourceFile, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const textByTurn = new Map(rows.map((row) => [row.turn, row.text]));
const specialKeywords = loadSpecialKeywords();
for (const record of records) {
  const text = textByTurn.get(record.turn) ?? '';
  record.keywords = [...new Set([
    ...extractKeywords(text, { limit: 12 }),
    ...matchSpecialKeywords(text, specialKeywords),
  ])];
}
saveIndexJsonl(indexFile, records);
console.log(JSON.stringify({ records: records.length, sample: records.slice(0, 2).map((record) => ({ turn: record.turn, keywords: record.keywords })) }, null, 2));
