#!/usr/bin/env node
/**
 * Load-gate replay + fuzz at 50 / 200 / 800 / 1500.
 * Checks decisions, scene purity and duplicate loads.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readEventLog } from '../src/memory/event-log.mjs';
import {
  MemoryLoadState,
  latestCandidate,
  candidateSegment,
  isSceneRecord,
} from '../src/memory/load-gate.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = argOf('--dir');
if (!dir) {
  console.error('usage: node bin/memory-load-gate-replay.mjs --dir .durable-memory');
  process.exit(2);
}
const records = readEventLog(path.join(dir, 'events.jsonl'));
const checkpoints = [50, 200, 800, 1500];
const dev = { activity: '开发', topic: '技术' };
const run = { activity: '跑团', topic: '剧情' };

const scenarios = [
  { id: 'start-run', text: '我们现在开始跑团吧', facets: run, expected: 'load' },
  { id: 'plain-start', text: '开始跑团', facets: run, expected: 'load' },
  { id: 'open-table', text: '开团', facets: run, expected: 'load' },
  { id: 'coo-start', text: 'Coo：来一局', facets: run, expected: 'load', role: 'coo' },
  { id: 'meta-rules', text: '规则怎么写', facets: dev, expected: 'none' },
  { id: 'ordinary-mention', text: '跑团这个设计挺有意思', facets: dev, expected: 'none' },
  { id: 'generic-start', text: '开始写文档', facets: dev, expected: 'none' },
  { id: 'recall-run', text: '上次跑团怎么样了', facets: run, expected: 'load' },
  { id: 'recall-vague', text: '之前那个呢', facets: run, expected: 'load' },
  { id: 'new-scene', text: '灯室见', facets: run, expected: 'hint' },
  { id: 'coo-new-scene', text: 'Coo：灯室见', facets: run, expected: 'load', role: 'coo' },
  { id: 'same-scene', text: '我推门进去', facets: run, expected: 'none', initial: run },
  { id: 'assistant', text: '开始跑团', facets: run, expected: 'none', role: 'assistant' },
  { id: 'low-confidence', text: '开始跑团', facets: run, expected: 'none', confidence: 0.3 },
];

const output = [];
for (const checkpoint of checkpoints) {
  const visible = records.filter((record) => record.turn <= checkpoint);
  const actual = [];
  const state = new MemoryLoadState();
  for (const record of visible) {
    const prior = visible.filter((item) => item.turn < record.turn);
    const candidate = latestCandidate(prior, 'activity', record.facets.activity);
    const result = state.decide({
      text: record.text,
      currentFacets: record.facets,
      confidence: 0.9,
      nowTurn: record.turn,
      hasCandidate: candidate !== null,
      candidate,
    });
    if (result.action === 'load') {
      const segment = candidateSegment(visible, candidate);
      actual.push({
        turn: record.turn,
        reason: result.reason,
        candidateTurn: candidate?.turn ?? null,
        pure: candidate === null ? false : isSceneRecord(candidate),
        segmentTurns: segment?.turns ?? 0,
      });
      state.recordLoad({ facets: record.facets, seq: segment?.seqStart ?? null, nowTurn: record.turn, reason: result.reason });
    } else if (result.action === 'hint') {
      actual.push({ turn: record.turn, reason: result.reason, hint: true });
    }
  }

  const fuzz = [];
  for (const testCase of scenarios) {
    const candidate = latestCandidate(visible, 'activity', testCase.facets.activity);
    const segment = candidateSegment(visible, candidate);
    const testState = new MemoryLoadState({ loadedFacets: testCase.initial ?? dev, loadedAtTurn: checkpoint - 1 });
    const result = testState.decide({
      text: testCase.text,
      currentFacets: testCase.facets,
      confidence: testCase.confidence ?? 0.9,
      nowTurn: checkpoint,
      hasCandidate: candidate !== null,
      candidate,
      role: testCase.role ?? 'user',
    });
    const pass = (testCase.expected === 'load' && result.action === 'load')
      || (testCase.expected === 'none' && result.action === 'none')
      || (testCase.expected === 'hint' && result.action === 'hint');
    fuzz.push({
      id: testCase.id,
      expected: testCase.expected,
      actual: result.action,
      reason: result.reason,
      pass,
      candidateTurn: candidate?.turn ?? null,
      candidatePure: candidate === null ? false : isSceneRecord(candidate),
      segmentTurns: segment?.turns ?? 0,
    });
  }

  const loads = actual.filter((item) => item.hint !== true);
  output.push({
    checkpoint,
    visible: visible.length,
    naturalLoads: loads.length,
    naturalHints: actual.filter((item) => item.hint === true).length,
    impureLoads: loads.filter((item) => !item.pure).length,
    impureSample: loads.filter((item) => !item.pure).slice(0, 6),
    duplicateActivityLoads: loads.filter((item, index) => index > 0
      && item.reason === 'activity-change'
      && loads[index - 1].reason === 'activity-change').length,
    fuzzPass: fuzz.filter((item) => item.pass).length,
    fuzzTotal: fuzz.length,
    fuzzFailures: fuzz.filter((item) => !item.pass),
    impureCandidates: fuzz.filter((item) => !item.candidatePure).map((item) => item.id),
    naturalSample: loads.slice(0, 4),
    fuzz,
  });
}
const result = { dir, output };
fs.writeFileSync(path.join(dir, 'LOAD-GATE-REPLAY.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(output.map((entry) => ({
  checkpoint: entry.checkpoint,
  naturalLoads: entry.naturalLoads,
  naturalHints: entry.naturalHints,
  impureLoads: entry.impureLoads,
  duplicateActivityLoads: entry.duplicateActivityLoads,
  fuzzPass: `${entry.fuzzPass}/${entry.fuzzTotal}`,
  fuzzFailures: entry.fuzzFailures.map((item) => item.id),
})), null, 2));
