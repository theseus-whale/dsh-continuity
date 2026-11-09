import fs from 'node:fs';
import { loadIndexJsonl } from '../src/memory/bc-index.mjs';
import {
  createCMap, expandWindow, learnFromExplanation, markAsked, renderNote, retrieve,
} from '../src/memory/bc-recall.mjs';

const root = 'C:/Users/35794/Documents/DeepSeek\'s Sandbox/coopanion-continuity';
const indexPath = `${root}/projects/bc-recall/data/index.jsonl`;
const sourcePath = `${root}/backups/continuity-tags-20261031/online400/continuity-1500.jsonl`;
const records = loadIndexJsonl(indexPath);
const rawRows = fs.readFileSync(sourcePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const rawByTurn = new Map(rawRows.map((row) => [row.turn, row]));
const relevant = new Set(rawRows.filter((row) => row.facets?.activity === '跑团').map((row) => row.turn));
const cmap = createCMap();

function inspect(hit) {
  if (!hit) return null;
  const row = rawByTurn.get(hit.turn);
  return {
    turn: hit.turn,
    seqStart: hit.seqStart,
    seqEnd: hit.seqEnd,
    sourceFacet: row?.facets?.activity ?? null,
    text: String(row?.text ?? '').replace(/\s+/g, ' ').slice(0, 180),
  };
}

function summarize(name, result) {
  const turns = (result.hits ?? []).map((hit) => hit.turn);
  const relevantHits = turns.filter((turn) => relevant.has(turn)).length;
  return {
    name,
    kind: result.kind,
    via: result.via ?? null,
    hits: turns.length,
    relevantHits,
    extraHits: turns.length - relevantHits,
    recall: relevant.size === 0 ? 0 : Number((relevantHits / relevant.size).toFixed(3)),
    note: renderNote(result),
    samples: (result.hits ?? []).slice(0, 3).map(inspect),
  };
}

const out = { records: records.length, relevantTurns: relevant.size, cases: [] };

// 1. B direct game
out.cases.push(summarize('游戏 B direct', retrieve({ records, cmap, query: '游戏', minConceptScore: 0.35 })));

// 2. Cold start + once
const cold = retrieve({ records, cmap, query: '跑团' });
out.cases.push(summarize('跑团 cold', cold));
markAsked(cmap, '跑团');
out.cases.push(summarize('跑团 after ask', retrieve({ records, cmap, query: '跑团' })));

// 3. Learn C and retrieve
const learned = learnFromExplanation(cmap, '跑团', '就是游戏、故事、对话', { records });
const retrieved = retrieve({ records: learned.records, cmap, query: '跑团', minConceptScore: 0.35 });
const window = expandWindow(learned.records, retrieved.hits?.[0], { maxTurns: 3 });
out.cases.push({
  ...summarize('跑团 after C', retrieved),
  window,
  windowSeqs: window.turns.map((turn) => rawByTurn.get(turn)?.seqStart ?? null),
});

// 4. Technical concept
out.cases.push(summarize('技术 B direct', retrieve({ records, cmap, query: '技术', minConceptScore: 0.35 })));

// 5. Unseen concept + synthetic record
const synthetic = {
  turn: 9999, seqStart: 999900, seqEnd: 999900,
  generic: ['病毒', '公共卫生'], terms: ['COVID-19'],
  conceptScores: { 病毒: 0.61, 公共卫生: 0.55 }, confidence: 0.61, status: 'weak',
};
const withSynthetic = [...learned.records, synthetic];
const virusCold = retrieve({ records: withSynthetic, cmap, query: 'COVID-19' });
out.cases.push(summarize('COVID-19 cold', virusCold));
markAsked(cmap, 'COVID-19');
learnFromExplanation(cmap, 'COVID-19', '就是病毒、公共卫生', { records: withSynthetic });
const virusAfter = retrieve({ records: withSynthetic, cmap, query: 'COVID-19', minConceptScore: 0.35 });
out.cases.push({
  ...summarize('COVID-19 after C', virusAfter),
  syntheticText: 'COVID-19 起源报告，实验室泄漏，自然宿主，冷链传播。',
});

// 6. Truly unknown term
out.cases.push(summarize('量子计算 cold', retrieve({ records, cmap, query: '量子计算' })));
markAsked(cmap, '量子计算');
out.cases.push(summarize('量子计算 after ask', retrieve({ records, cmap, query: '量子计算' })));

fs.writeFileSync(`${root}/projects/bc-recall/acceptance-full.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
