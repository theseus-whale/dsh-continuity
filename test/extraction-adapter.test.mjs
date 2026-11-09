import assert from 'node:assert/strict';
import test from 'node:test';
import { PreTurnController } from '../src/memory/pre-turn.mjs';
import { MemoryLoadState } from '../src/memory/load-gate.mjs';
import { attachExtraction, attachStructuredExtraction } from '../src/memory/extraction-adapter.mjs';

const run = { activity: '跑团', topic: '剧情' };
const dev = { activity: '开发', topic: '技术' };
const records = [
  { turn: 1, seqStart: 10, seqEnd: 10, text: '写插件', facets: { ...dev, medium: '文字' }, hash: 'a' },
  { turn: 2, seqStart: 20, seqEnd: 20, text: '进灯室', facets: { ...run, medium: '文字' }, hash: 'b' },
];

test('extractor entities become EventModel slots and gate input', () => {
  const controller = new PreTurnController({
    records,
    gate: new MemoryLoadState({ loadedFacets: dev, loadedAtTurn: 1 }),
  });
  const result = attachExtraction(controller, {
    text: '我们现在开始跑团，进灯室',
    entities: [
      { text: '灯室', label: 'LOC' },
      { text: '宁', label: 'PER' },
      { text: '钥匙', label: 'OBJECT' },
    ],
    facets: run,
    confidence: 0.9,
    nowTurn: 5,
  });
  assert.equal(result.ok, true);
  assert.equal(result.slots.location, '灯室');
  assert.deepEqual(result.slots.characters, ['宁']);
  assert.equal(result.gate.action, 'load');
});

test('coref clusters extend the extracted slots', () => {
  const controller = new PreTurnController({
    records,
    gate: new MemoryLoadState({ loadedFacets: dev, loadedAtTurn: 1 }),
  });
  const result = attachExtraction(controller, {
    text: 'Coo走进灯室。她看着外套。',
    entities: [{ text: '灯室', label: 'LOC' }],
    corefClusters: [{ clusterId: 'coref:1', canonical: 'Coo', mentions: [{ text: 'Coo' }, { text: '她' }] }],
    facets: run,
    confidence: 0.9,
    nowTurn: 5,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.slots.characters, ['Coo']);
  assert.equal(result.slots.location, '灯室');
  assert.equal(result.referents[0].canonical, 'Coo');
});

test('SRL + coref + links flow through one structured adapter', () => {
  const controller = new PreTurnController({
    records,
    gate: new MemoryLoadState({ loadedFacets: dev, loadedAtTurn: 1 }),
  });
  const result = attachStructuredExtraction(controller, {
    text: 'The player kicked the ball into the net.',
    srl: {
      verb: 'kicked',
      words: ['The', 'player', 'kicked', 'the', 'ball', 'into', 'the', 'net', '.'],
      tags: ['B-ARG0', 'I-ARG0', 'B-V', 'B-ARG1', 'I-ARG1', 'B-ARGM-DIR', 'I-ARGM-DIR', 'I-ARGM-DIR', 'O'],
    },
    corefClusters: [{ clusterId: 'coref:1', canonical: 'The player', mentions: [{ text: 'The player' }, { text: 'he' }] }],
    entityLinks: [{ text: 'The player', entityId: 'player:1', score: 0.8 }],
    facets: run,
    confidence: 0.9,
    nowTurn: 5,
  });
  assert.equal(result.ok, true);
  assert.equal(result.predicate, 'kicked');
  assert.deepEqual(result.slots.characters, ['The player']);
  assert.equal(result.slots.location, 'into the net');
  assert.equal(result.entityLinks[0].referent, 'player:1');
  assert.equal(result.referents[0].canonical, 'The player');
});

test('invalid extraction never reaches the gate', () => {
  const controller = new PreTurnController({
    records,
    gate: new MemoryLoadState({ loadedFacets: dev, loadedAtTurn: 1 }),
  });
  const result = attachExtraction(controller, {
    text: '继续',
    slots: { location: 42 },
    facets: run,
    nowTurn: 5,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid-slots');
  assert.equal(result.gate, null);
});
