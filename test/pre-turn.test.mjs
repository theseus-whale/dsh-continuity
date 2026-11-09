import assert from 'node:assert/strict';
import test from 'node:test';
import { PreTurnController } from '../src/memory/pre-turn.mjs';
import { MemoryLoadState } from '../src/memory/load-gate.mjs';

const dev = { activity: '开发', topic: '技术' };
const run = { activity: '跑团', topic: '剧情' };
const records = [
  { turn: 1, seqStart: 10, seqEnd: 10, text: '写插件', facets: { ...dev, medium: '文字' }, hash: 'a' },
  { turn: 2, seqStart: 20, seqEnd: 20, text: '进灯室', facets: { ...run, medium: '文字' }, hash: 'b' },
  { turn: 3, seqStart: 30, seqEnd: 30, text: '看外套', facets: { ...run, medium: '文字' }, hash: 'c' },
];

test('pre-turn loads on explicit start and updates gate state', () => {
  const controller = new PreTurnController({
    records,
    gate: new MemoryLoadState({ loadedFacets: dev, loadedAtTurn: 1 }),
  });
  const result = controller.step({
    text: '我们现在开始跑团吧',
    facets: run,
    eventSlots: { activity: '跑团', topic: '剧情', location: '灯室' },
    confidence: 0.9,
    nowTurn: 5,
  });
  assert.equal(result.action, 'load');
  assert.equal(result.candidateTurn, 3);
  assert.ok(result.segment.turns >= 1);
  const same = controller.step({
    text: '继续',
    facets: run,
    eventSlots: { activity: '跑团', topic: '剧情', location: '灯室' },
    confidence: 0.9,
    nowTurn: 6,
  });
  assert.equal(same.action, 'none');
});

test('topic-only change does not load through boundary', () => {
  const controller = new PreTurnController({
    records,
    gate: new MemoryLoadState({ loadedFacets: { ...dev, topic: '技术' }, loadedAtTurn: 1 }),
  });
  const result = controller.step({
    text: '换个话题',
    facets: { ...dev, topic: '规则' },
    eventSlots: { activity: '开发', topic: '规则', location: null },
    confidence: 0.9,
    nowTurn: 5,
  });
  assert.equal(result.action, 'none');
  assert.equal(result.boundaryScore, 0);
});

test('Coo boundary loads; assistant does not', () => {
  const controller = new PreTurnController({
    records,
    gate: new MemoryLoadState({ loadedFacets: dev, loadedAtTurn: 1 }),
  });
  const coo = controller.step({
    text: 'Coo：灯室见',
    role: 'coo',
    facets: run,
    eventSlots: { activity: '跑团', topic: '剧情', location: '灯室' },
    confidence: 0.9,
    nowTurn: 5,
  });
  assert.equal(coo.action, 'load');
  const assistant = controller.step({
    text: '开始跑团',
    role: 'assistant',
    facets: run,
    eventSlots: { activity: '跑团', topic: '剧情', location: '灯室' },
    confidence: 0.9,
    nowTurn: 6,
  });
  assert.equal(assistant.action, 'none');
});

test('invalid event slots are surfaced and do not create a boundary', () => {
  const controller = new PreTurnController({
    records,
    gate: new MemoryLoadState({ loadedFacets: dev, loadedAtTurn: 1 }),
  });
  const result = controller.step({
    text: '继续',
    facets: run,
    eventSlots: { location: 42 },
    confidence: 0.9,
    nowTurn: 5,
  });
  assert.equal(result.boundaryScore, 0);
  assert.equal(result.eventError, 'invalid-slots');
});
