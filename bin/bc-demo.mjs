import fs from 'node:fs';
import { backfillRecords, createCMap, learnTerm, makeRecord, renderNote, retrieve } from '../src/memory/bc-recall.mjs';

const rows = fs.readFileSync('C:/Users/35794/Documents/DeepSeek\'s Sandbox/coopanion-continuity/backups/continuity-tags-20261031/online400/continuity-1500.jsonl', 'utf8')
  .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  .filter((row) => row.facets?.activity === '跑团');

const genericOf = (facets) => {
  const out = [];
  if (facets.activity === '跑团') out.push('游戏');
  if (facets.activity === '对话') out.push('对话');
  if (['开发', '调试', '测试', '文档'].includes(facets.activity)) out.push('技术');
  if (facets.topic === '剧情') out.push('故事');
  if (['技术', '设备', '记忆', '规则'].includes(facets.topic)) out.push(facets.topic);
  return [...new Set(out)];
};

let records = rows.map((row) => makeRecord({
  turn: row.turn,
  seqStart: row.seqStart,
  seqEnd: row.seqEnd,
  text: row.text,
  generic: genericOf(row.facets),
  terms: row.facets.activity === '跑团' ? ['跑团'] : [],
}));
records = backfillRecords(records, '跑团', ['游戏', '故事']);
records.push(makeRecord({
  turn: 900,
  seqStart: 5000,
  seqEnd: 5001,
  text: 'COVID-19 起源报告，实验室泄漏，自然宿主，冷链传播。',
  generic: ['病毒', '公共卫生'],
  terms: ['COVID-19', '实验室泄漏'],
  status: 'weak',
  confidence: 0.33,
}));

const cmap = createCMap();
const out = [];
for (const query of ['游戏', '跑团', '病毒', 'COVID-19', '疫情']) {
  const result = retrieve({ records, cmap, query });
  out.push({ query, kind: result.kind, via: result.via ?? null, note: renderNote(result), hits: result.hits?.length ?? 0 });
}
learnTerm(cmap, '跑团', ['游戏', '故事', '对话']);
const learned = retrieve({ records, cmap, query: '跑团' });
out.push({ query: '跑团(after C)', kind: learned.kind, via: learned.via, note: renderNote(learned), hits: learned.hits?.length ?? 0 });
console.log(JSON.stringify({ records: records.length, examples: out }, null, 2));
