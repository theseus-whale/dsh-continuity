import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryLoadState, latestCandidate, candidateSegment } from '../src/memory/load-gate.mjs';

const dev = { activity: '开发', topic: '技术' };
const run = { activity: '跑团', topic: '剧情' };

test('explicit start loads even when the last activity differs', () => {
  const state = new MemoryLoadState({ loadedFacets: dev, loadedAtTurn: 10 });
  const result = state.decide({ text: '我们现在开始跑团吧', currentFacets: run, confidence: 0.9, nowTurn: 50 });
  assert.equal(result.action, 'load');
  assert.equal(result.reason, 'explicit-start');
});

test('Coo start message uses the same gate', () => {
  const state = new MemoryLoadState({ loadedFacets: dev, loadedAtTurn: 10 });
  const result = state.decide({ text: 'Coo：来一局', currentFacets: run, confidence: 0.9, nowTurn: 50 });
  assert.equal(result.action, 'load');
});

test('meta mention of rules does not load', () => {
  const state = new MemoryLoadState({ loadedFacets: dev, loadedAtTurn: 10 });
  const result = state.decide({ text: '规则怎么写', currentFacets: dev, confidence: 0.9, nowTurn: 50 });
  assert.equal(result.action, 'none');
});

test('activity change hints by default', () => {
  const state = new MemoryLoadState({ loadedFacets: dev, loadedAtTurn: 10 });
  const result = state.decide({ text: '灯室见', currentFacets: run, confidence: 0.9, nowTurn: 50 });
  assert.equal(result.action, 'hint');
  assert.equal(result.reason, 'activity-change-hint');
});

test('activity change can auto-load when enabled', () => {
  const state = new MemoryLoadState({ loadedFacets: dev, loadedAtTurn: 10, autoActivityLoad: true });
  const result = state.decide({ text: '灯室见', currentFacets: run, confidence: 0.9, nowTurn: 50 });
  assert.equal(result.action, 'load');
  assert.equal(result.reason, 'activity-change');
});

test('Coo activity change auto-loads', () => {
  const state = new MemoryLoadState({ loadedFacets: dev, loadedAtTurn: 10 });
  const result = state.decide({ text: 'Coo：灯室见', currentFacets: run, confidence: 0.9, role: 'coo', nowTurn: 50 });
  assert.equal(result.action, 'load');
  assert.equal(result.reason, 'activity-change');
});

test('boundary score 0 does not hint', () => {
  const state = new MemoryLoadState({ loadedFacets: dev, loadedAtTurn: 10 });
  const result = state.decide({ text: '换个话题', currentFacets: run, confidence: 0.9, nowTurn: 50, boundaryScore: 0 });
  assert.equal(result.action, 'none');
  assert.equal(result.reason, 'weak-boundary');
});

test('strong boundary hints for user and loads for Coo', () => {
  const state = new MemoryLoadState({ loadedFacets: dev, loadedAtTurn: 10 });
  const user = state.decide({ text: '灯室见', currentFacets: run, confidence: 0.9, nowTurn: 50, boundaryScore: 0.35 });
  assert.equal(user.action, 'hint');
  const coo = state.decide({ text: 'Coo：灯室见', currentFacets: run, confidence: 0.9, role: 'coo', nowTurn: 50, boundaryScore: 0.35 });
  assert.equal(coo.action, 'load');
  assert.equal(coo.reason, 'boundary-change');
});

test('custom abstention threshold blocks mid-confidence load', () => {
  const state = new MemoryLoadState({ loadedFacets: dev, loadedAtTurn: 10, abstainThreshold: 0.65 });
  const result = state.decide({ text: '开始跑团', currentFacets: run, confidence: 0.6, nowTurn: 50 });
  assert.equal(result.action, 'none');
  assert.equal(result.reason, 'low-confidence');
});

test('assistant text never triggers the gate', () => {
  const state = new MemoryLoadState({ loadedFacets: dev, loadedAtTurn: 10 });
  assert.equal(state.decide({ text: '开始跑团', currentFacets: run, role: 'assistant', nowTurn: 50 }).action, 'none');
});

test('same context does not reload', () => {
  const state = new MemoryLoadState({ loadedFacets: run, loadedAtTurn: 10 });
  const result = state.decide({ text: '我推门进去', currentFacets: run, confidence: 0.9, nowTurn: 20 });
  assert.equal(result.action, 'none');
});

test('bare 最后 in a narrative is not a recall trigger', () => {
  const state = new MemoryLoadState({ loadedFacets: dev, loadedAtTurn: 10 });
  const result = state.decide({ text: '最后的日落很美', currentFacets: dev, confidence: 0.9, nowTurn: 50 });
  assert.equal(result.action, 'none');
});

test('bare 之前 in a general statement is not a recall trigger', () => {
  const state = new MemoryLoadState({ loadedFacets: dev, loadedAtTurn: 10 });
  const result = state.decide({ text: '四岁之前的事情我不记得', currentFacets: dev, confidence: 0.9, nowTurn: 50 });
  assert.equal(result.action, 'none');
});

test('explicit recall loads', () => {
  const state = new MemoryLoadState({ loadedFacets: dev, loadedAtTurn: 10 });
  const result = state.decide({ text: '上次跑团怎么样了', currentFacets: run, confidence: 0.9, nowTurn: 50 });
  assert.equal(result.action, 'load');
  assert.equal(result.reason, 'explicit-recall');
});

test('low confidence does not load', () => {
  const state = new MemoryLoadState({ loadedFacets: dev, loadedAtTurn: 10 });
  assert.equal(state.decide({ text: '开始跑团', currentFacets: run, confidence: 0.3, nowTurn: 50 }).action, 'none');
});

test('recordLoad changes the baseline', () => {
  const state = new MemoryLoadState({ loadedFacets: dev, loadedAtTurn: 10 });
  const result = state.decide({ text: '开始跑团', currentFacets: run, confidence: 0.9, nowTurn: 50 });
  state.recordLoad({ facets: run, seq: 3481, nowTurn: 50, reason: result.reason });
  assert.deepEqual(state.loadedFacets, run);
  assert.equal(state.loadedSeq, 3481);
  assert.equal(state.decide({ text: '继续', currentFacets: run, confidence: 0.9, nowTurn: 55 }).action, 'none');
});

test('latestCandidate finds the last matching history turn', () => {
  const records = [
    { turn: 1, facets: run },
    { turn: 2, facets: dev },
    { turn: 3, facets: run },
  ];
  assert.equal(latestCandidate(records, 'activity', '跑团').turn, 3);
  assert.equal(latestCandidate(records, 'activity', '测试'), null);
});

test('latestCandidate skips meta/code tail and returns a scene segment', () => {
  const records = [
    { turn: 1, seqStart: 10, seqEnd: 10, facets: run, text: '推门进灯室。' },
    { turn: 2, seqStart: 20, seqEnd: 20, facets: run, text: '灯还亮着。' },
    { turn: 3, seqStart: 30, seqEnd: 30, facets: { ...run, medium: '代码' }, text: 'TAG: T8 存档回执' },
  ];
  const candidate = latestCandidate(records, 'activity', '跑团');
  assert.equal(candidate.turn, 2);
  const segment = candidateSegment(records, candidate);
  assert.equal(segment.seqStart, 10);
  assert.equal(segment.seqEnd, 20);
  assert.equal(segment.turns, 2);
});
