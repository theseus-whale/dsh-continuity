#!/usr/bin/env node
/**
 * Closed-loop probe: local MLP facet prediction -> gate -> scene candidate.
 * Compares raw MLP vs retrieval-stabilized facets.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readEventLog } from '../src/memory/event-log.mjs';
import { BM25Index } from '../src/memory/bm25.mjs';
import { VectorIndex } from '../src/memory/vector-index.mjs';
import { embedTexts } from '../src/facets/embedding.mjs';
import { deserializeMlp, predictMlp } from '../src/facets/mlp-probe.mjs';
import { MemoryLoadState, latestCandidate, candidateSegment } from '../src/memory/load-gate.mjs';
import { stabilizeFacets } from '../src/memory/facet-stabilizer.mjs';
import { summaryIndex } from '../src/memory/planner.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = argOf('--dir');
const modelPath = argOf('--model');
if (!dir || !modelPath) {
  console.error('usage: node bin/memory-closed-loop.mjs --dir .durable-memory --model MLP-MODEL.json');
  process.exit(2);
}
const records = readEventLog(path.join(dir, 'events.jsonl'));
const bm25 = BM25Index.fromJSON(JSON.parse(fs.readFileSync(path.join(dir, 'bm25.json'), 'utf8')));
const vectors = VectorIndex.fromJSON(JSON.parse(fs.readFileSync(path.join(dir, 'vectors.json'), 'utf8')));
const model = deserializeMlp(JSON.parse(fs.readFileSync(modelPath, 'utf8')));
const tree = JSON.parse(fs.readFileSync(path.join(dir, 'summary-tree.json'), 'utf8'));
const summaries = summaryIndex(tree);
const dev = { activity: '开发', topic: '技术' };
const messages = [
  ['我们现在开始跑团吧', 'load'],
  ['开团', 'load'],
  ['TRPG 开一把', 'load'],
  ['来一局', 'load'],
  ['规则怎么写', 'none'],
  ['规则文档在哪', 'none'],
  ['上次跑团怎么样了', 'load'],
  ['钥匙最后交给谁了', 'load'],
  ['沈砚后来呢', 'load'],
  ['跑团这个设计挺有意思', 'none'],
  ['我推门进灯室', 'hint'],
  ['Coo：灯室见', 'load'],
  ['开始写文档', 'none'],
  ['更新 README', 'none'],
  ['开始调试插件', 'none'],
  ['修一下这个 bug', 'none'],
  ['今天天气不错', 'none'],
  ['量子计算怎么样', 'none'],
];
const vectorsByText = new Map();
for (const [text] of messages) {
  const [vector] = await embedTexts([text]);
  vectorsByText.set(text, vector);
}

const rows = [];
for (const [text, expected] of messages) {
  const vector = vectorsByText.get(text);
  const raw = predictMlp(model, vector);
  const keyword = bm25.search(text, { topK: 5, minCoverage: 0.4 });
  const semantic = vectors.search(vector, { topK: 5 });
  const summary = summaries.search(text, { topK: 3, minCoverage: 0.3 });
  const stabilized = stabilizeFacets({ raw, text, records, keyword, semantic, summary });
  const candidate = latestCandidate(records, 'activity', stabilized.facets.activity);
  const segment = candidateSegment(records, candidate);
  const gateState = new MemoryLoadState({ loadedFacets: dev, loadedAtTurn: 1490 });
  const rawCandidate = latestCandidate(records, 'activity', raw.facets.activity);
  const rawGate = gateState.decide({
    text,
    currentFacets: raw.facets,
    confidence: raw.confidence.activity ?? 0,
    nowTurn: 1500,
    hasCandidate: rawCandidate !== null,
    candidate: rawCandidate,
    role: text.startsWith('Coo') ? 'coo' : 'user',
  });
  const stableGate = gateState.decide({
    text,
    currentFacets: stabilized.facets,
    confidence: stabilized.confidence.activity ?? 0,
    nowTurn: 1500,
    hasCandidate: candidate !== null,
    candidate,
    role: text.startsWith('Coo') ? 'coo' : 'user',
  });
  rows.push({
    text,
    expected,
    rawPass: rawGate.action === expected,
    stablePass: stableGate.action === expected,
    rawFacets: raw.facets,
    rawConfidence: Object.fromEntries(Object.entries(raw.confidence).map(([key, value]) => [key, +value.toFixed(2)])),
    evidence: { activity: stabilized.evidence.activity, topic: stabilized.evidence.topic },
    stabilized: stabilized.facets,
    stabilizeReason: stabilized.reason,
    rawGate: rawGate.action,
    rawReason: rawGate.reason,
    stableGate: stableGate.action,
    stableReason: stableGate.reason,
    candidateTurn: candidate?.turn ?? null,
    segmentTurns: segment?.turns ?? 0,
  });
}
const summary = {
  cases: rows.length,
  rawPass: rows.filter((row) => row.rawPass).length,
  stablePass: rows.filter((row) => row.stablePass).length,
  rawFailures: rows.filter((row) => !row.rawPass).map((row) => row.text),
  stableFailures: rows.filter((row) => !row.stablePass).map((row) => row.text),
  lowActivityConfidence: rows.filter((row) => row.rawConfidence.activity < 0.7).length,
  changedByStabilizer: rows.filter((row) => row.rawFacets.activity !== row.stabilized.activity).length,
};
console.log(JSON.stringify({ model: path.basename(modelPath), summary, rows }, null, 2));
fs.writeFileSync(path.join(dir, 'CLOSED-LOOP.json'), JSON.stringify({ model: path.basename(modelPath), summary, rows }, null, 2));
