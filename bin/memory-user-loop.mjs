#!/usr/bin/env node
/**
 * Real user-message loop: BGE + MLP facets + NER slots + pre-turn gate.
 * No live session IO.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readEventLog } from '../src/memory/event-log.mjs';
import { PreTurnController } from '../src/memory/pre-turn.mjs';
import { MemoryLoadState } from '../src/memory/load-gate.mjs';
import { attachExtraction } from '../src/memory/extraction-adapter.mjs';
import { embedTexts } from '../src/facets/embedding.mjs';
import { deserializeMlp, predictMlp } from '../src/facets/mlp-probe.mjs';
import { BM25Index } from '../src/memory/bm25.mjs';
import { VectorIndex } from '../src/memory/vector-index.mjs';
import { summaryIndex } from '../src/memory/planner.mjs';
import { stabilizeFacets } from '../src/memory/facet-stabilizer.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = argOf('--dir');
const nerFile = argOf('--ner');
const modelPath = argOf('--model');
if (!dir || !nerFile || !modelPath) {
  console.error('usage: node bin/memory-user-loop.mjs --dir .durable-memory --ner USER-NER.json --model MLP-MODEL.json');
  process.exit(2);
}
const records = readEventLog(path.join(dir, 'events.jsonl'));
const ner = JSON.parse(fs.readFileSync(nerFile, 'utf8'));
const model = deserializeMlp(JSON.parse(fs.readFileSync(modelPath, 'utf8')));
const bm25 = BM25Index.fromJSON(JSON.parse(fs.readFileSync(path.join(dir, 'bm25.json'), 'utf8')));
const vectorIndex = VectorIndex.fromJSON(JSON.parse(fs.readFileSync(path.join(dir, 'vectors.json'), 'utf8')));
const tree = JSON.parse(fs.readFileSync(path.join(dir, 'summary-tree.json'), 'utf8'));
const summaries = summaryIndex(tree);
const texts = ner.rows.map((row) => row.text);
const vectors = await embedTexts(texts);
const controller = new PreTurnController({
  records,
  gate: new MemoryLoadState({ loadedFacets: { activity: '开发', topic: '技术' }, loadedAtTurn: 0 }),
});
const rows = [];
for (let index = 0; index < ner.rows.length; index += 1) {
  const item = ner.rows[index];
  const prediction = predictMlp(model, vectors[index]);
  const keyword = bm25.search(item.text, { topK: 5, minCoverage: 0.3 });
  const semantic = vectorIndex.search(vectors[index], { topK: 5 });
  const summary = summaries.search(item.text, { topK: 3, minCoverage: 0.3 });
  const stable = stabilizeFacets({
    raw: prediction,
    text: item.text,
    records,
    keyword,
    semantic,
    summary,
  });
  const result = attachExtraction(controller, {
    text: item.text,
    entities: item.entities,
    slots: item.slots,
    facets: stable.facets,
    confidence: stable.confidence.activity,
    nowTurn: 1000 + index,
  });
  rows.push({
    turn: item.turn,
    text: item.text,
    facets: stable.facets,
    rawFacets: prediction.facets,
    confidence: +stable.confidence.activity.toFixed(2),
    stabilizeReason: stable.reason,
    slots: item.slots,
    entities: item.entities,
    ok: result.ok,
    action: result.gate?.action ?? 'invalid',
    reason: result.gate?.reason ?? result.reason,
    boundaryScore: result.gate?.boundaryScore ?? null,
    candidateTurn: result.gate?.candidateTurn ?? null,
    segmentTurns: result.gate?.segment?.turns ?? 0,
  });
}
const summary = {
  messages: rows.length,
  loads: rows.filter((row) => row.action === 'load').length,
  hints: rows.filter((row) => row.action === 'hint').length,
  none: rows.filter((row) => row.action === 'none').length,
  invalid: rows.filter((row) => row.action === 'invalid').length,
  withEntities: rows.filter((row) => row.entities.length > 0).length,
  loadsSample: rows.filter((row) => row.action === 'load').slice(0, 8).map((row) => ({ turn: row.turn, text: row.text.slice(0, 80), reason: row.reason })),
};
const output = { summary, rows };
fs.writeFileSync(path.join(dir, 'USER-LOOP.json'), JSON.stringify(output, null, 2));
console.log(JSON.stringify(summary, null, 2));
