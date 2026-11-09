import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeSrl,
  srlToSlots,
  normalizeCoref,
  normalizeEntityLinks,
} from '../src/memory/structured-adapters.mjs';
import { PreTurnController } from '../src/memory/pre-turn.mjs';
import { MemoryLoadState } from '../src/memory/load-gate.mjs';

test('SRL arguments map to event slots', () => {
  const result = normalizeSrl({
    predicate: '进',
    arguments: [
      { label: 'ARG0', text: '宁' },
      { label: 'ARG1', text: '钥匙' },
      { label: 'ARGM-LOC', text: '灯室' },
      { label: 'ARGM-GOL', text: '找外套' },
    ],
  });
  assert.deepEqual(result.slots.characters, ['宁']);
  assert.equal(result.slots.location, '灯室');
  assert.equal(result.slots.goal, '找外套');
  assert.deepEqual(result.slots.objects, ['钥匙']);
});

test('coreference clusters produce canonical referents', () => {
  const clusters = normalizeCoref([
    { mentions: [{ text: 'Coo', start: 0, end: 3, isCanonical: true }, { text: '她', start: 10, end: 11 }] },
  ]);
  assert.equal(clusters[0].clusterId, 'coref:1');
  assert.equal(clusters[0].canonical, 'Coo');
  assert.equal(clusters[0].mentions.length, 2);
});

test('entity links preserve NIL and scores', () => {
  const links = normalizeEntityLinks([
    { text: '星港', entityId: 'run:1', score: 0.9 },
    { text: '未知', entityId: null, score: 0.2 },
  ]);
  assert.equal(links[0].referent, 'run:1');
  assert.equal(links[1].referent, 'NIL');
  assert.equal(links[0].score, 0.9);
});

test('SRL tag output maps to slots', () => {
  const result = srlToSlots({
    words: ['The', 'player', 'kicked', 'the', 'ball', 'into', 'the', 'net', '.'],
    tags: ['B-ARG0', 'I-ARG0', 'B-V', 'B-ARG1', 'I-ARG1', 'B-ARGM-DIR', 'I-ARGM-DIR', 'I-ARGM-DIR', 'O'],
    verb: 'kicked',
  });
  assert.equal(result.predicate, 'kicked');
  assert.deepEqual(result.slots.characters, ['The player']);
  assert.deepEqual(result.slots.objects, ['the ball']);
  assert.equal(result.slots.location, 'into the net');
});

test('SRL slots can drive the pre-turn gate', () => {
  const srl = normalizeSrl({
    predicate: '进',
    arguments: [
      { label: 'ARG0', text: '宁' },
      { label: 'ARG1', text: '钥匙' },
      { label: 'ARGM-LOC', text: '灯室' },
    ],
  });
  const run = { activity: '跑团', topic: '剧情' };
  const dev = { activity: '开发', topic: '技术' };
  const records = [
    { turn: 1, seqStart: 10, seqEnd: 10, text: '写插件', facets: { ...dev, medium: '文字' }, hash: 'a' },
    { turn: 2, seqStart: 20, seqEnd: 20, text: '进灯室', facets: { ...run, medium: '文字' }, hash: 'b' },
  ];
  const controller = new PreTurnController({
    records,
    gate: new MemoryLoadState({ loadedFacets: dev, loadedAtTurn: 1 }),
  });
  const result = controller.step({
    text: '我们现在开始跑团，进灯室',
    facets: run,
    eventSlots: srl.slots,
    confidence: 0.9,
    nowTurn: 5,
  });
  assert.equal(result.action, 'load');
  assert.equal(result.segment.turns, 1);
  assert.deepEqual(srl.slots.characters, ['宁']);
  assert.equal(srl.slots.location, '灯室');
});
