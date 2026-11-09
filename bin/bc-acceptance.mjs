import fs from 'node:fs';
import { loadBCStore } from '../src/memory/bc-store.mjs';
import { learnFromExplanation, retrieve, renderNote } from '../src/memory/bc-recall.mjs';

const file = process.argv[2] ?? 'C:/Users/35794/Documents/DeepSeek\'s Sandbox/coopanion-continuity/projects/bc-recall/data/store.json';
const store = loadBCStore(file);
const before = {};
for (const query of ['游戏', '跑团', '病毒']) {
  const result = retrieve({ records: store.records, cmap: store.cmap, query, minConceptScore: 0.35 });
  before[query] = { kind: result.kind, via: result.via ?? null, hits: result.hits?.length ?? 0, note: renderNote(result) };
}
const learned = learnFromExplanation(store.cmap, '跑团', '就是游戏、故事、对话', { records: store.records });
const after = retrieve({ records: learned.records, cmap: store.cmap, query: '跑团', minConceptScore: 0.35 });
const report = {
  store: file,
  records: store.records.length,
  before,
  learned: { ok: learned.ok, generic: learned.generic },
  after: { kind: after.kind, via: after.via, hits: after.hits?.length ?? 0, note: renderNote(after) },
};
fs.writeFileSync('C:/Users/35794/Documents/DeepSeek\'s Sandbox/coopanion-continuity/projects/bc-recall/acceptance.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
