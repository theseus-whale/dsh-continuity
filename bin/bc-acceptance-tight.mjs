import fs from 'node:fs';
import { loadIndexJsonl } from '../src/memory/bc-index.mjs';
import {
  createCMap, learnFromExplanation, markAsked, renderNote, retrieve,
} from '../src/memory/bc-recall.mjs';

const root = 'C:/Users/example/Documents/DeepSeek\'s Sandbox/coopanion-continuity';
const records = loadIndexJsonl(`${root}/projects/bc-recall/data/index.jsonl`);
const rows = fs.readFileSync(`${root}/backups/continuity-tags-20261031/online400/continuity-1500.jsonl`, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const rawByTurn = new Map(rows.map((row) => [row.turn, row]));
const relevant = new Set(rows.filter((row) => row.facets?.activity === '跑团').map((row) => row.turn));
const cmap = createCMap();

function sample(turn) {
  const row = rawByTurn.get(turn);
  return row === undefined ? null : {
    turn,
    seqStart: row.seqStart,
    sourceFacet: row.facets?.activity ?? null,
    text: String(row.text).replace(/\s+/g, ' ').slice(0, 120),
  };
}

function caseOf(name, result) {
  const turns = (result.hits ?? []).map((hit) => hit.turn);
  return {
    name,
    kind: result.kind,
    via: result.via ?? null,
    hits: turns.length,
    relevantHits: turns.filter((turn) => relevant.has(turn)).length,
    extraHits: turns.filter((turn) => !relevant.has(turn)).length,
    note: renderNote(result),
    seedSamples: turns.slice(0, 3).map(sample),
  };
}

const out = { records: records.length, relevantTurns: relevant.size, cases: [] };
out.cases.push(caseOf('游戏 B direct', retrieve({ records, cmap, query: '游戏', minConceptScore: 0.35 })));
out.cases.push(caseOf('跑团 cold', retrieve({ records, cmap, query: '跑团' })));
markAsked(cmap, '跑团');
out.cases.push(caseOf('跑团 after ask', retrieve({ records, cmap, query: '跑团' })));
const learned = learnFromExplanation(cmap, '跑团', '就是游戏、故事、对话', { records });
const run = retrieve({ records: learned.records, cmap, query: '跑团', minConceptScore: 0.35 });
out.cases.push(caseOf('跑团 after C', run));
// Only an explicit LLM read, not an automatic expansion.
const seedTurn = run.hits?.[0]?.turn;
if (seedTurn !== undefined) {
  const turns = [];
  for (let turn = seedTurn - 3; turn <= seedTurn + 3; turn += 1) {
    if (rawByTurn.has(turn)) turns.push(turn);
  }
  out.llmRead = { seedTurn, chosenTurns: turns, samples: turns.map(sample) };
}
out.cases.push(caseOf('技术 B direct', retrieve({ records, cmap, query: '技术', minConceptScore: 0.35 })));
const synthetic = { turn: 9999, seqStart: 999900, seqEnd: 999900, generic: ['病毒', '公共卫生'], terms: ['COVID-19'], keywords: ['COVID-19', '实验室泄漏', '自然宿主', '冷链传播'], conceptScores: { 病毒: 0.61, 公共卫生: 0.55 }, confidence: 0.61, status: 'weak' };
const withSynthetic = [...learned.records, synthetic];
out.cases.push(caseOf('COVID-19 cold', retrieve({ records: withSynthetic, cmap, query: 'COVID-19' })));
markAsked(cmap, 'COVID-19');
learnFromExplanation(cmap, 'COVID-19', '就是病毒、公共卫生', { records: withSynthetic });
out.cases.push(caseOf('COVID-19 after C', retrieve({ records: withSynthetic, cmap, query: 'COVID-19', minConceptScore: 0.35 })));
out.cases.push(caseOf('量子计算 cold', retrieve({ records, cmap, query: '量子计算' })));
markAsked(cmap, '量子计算');
out.cases.push(caseOf('量子计算 after ask', retrieve({ records, cmap, query: '量子计算' })));
fs.writeFileSync(`${root}/projects/bc-recall/acceptance-tight.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
