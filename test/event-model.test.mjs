import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boundaryScore,
  EventModelState,
  extractEventSlots,
  validateEventSlots,
} from '../src/memory/event-model.mjs';

const base = {
  location: '灯室',
  characters: ['宁', 'Coo'],
  goal: '找外套',
  objects: ['钥匙'],
  activity: '跑团',
  topic: '剧情',
};

test('topic-only change is not a boundary', () => {
  const result = boundaryScore(base, { ...base, topic: '规则' });
  assert.equal(result.score, 0);
  const state = new EventModelState({ slots: base });
  assert.equal(state.observe({ slots: { ...base, topic: '规则' } }).boundary, false);
});

test('activity-only change is weak, not a boundary', () => {
  const result = boundaryScore(base, { ...base, activity: '开发' });
  assert.equal(result.score, 0.1);
  assert.equal(new EventModelState({ slots: base }).observe({ slots: { ...base, activity: '开发' } }).boundary, false);
});

test('location change is a boundary', () => {
  const result = boundaryScore(base, { ...base, location: '钟楼' });
  assert.equal(result.score, 0.35);
  assert.equal(new EventModelState({ slots: base }).observe({ slots: { ...base, location: '钟楼' } }).boundary, true);
});

test('goal and location change is a stronger boundary', () => {
  const result = boundaryScore(base, { ...base, location: '钟楼', goal: '敲钟' });
  assert.equal(result.score, 0.6);
});

test('explicit boundary opens even when slots are unchanged', () => {
  const state = new EventModelState({ slots: base });
  const result = state.observe({ slots: base, explicitBoundary: true });
  assert.equal(result.boundary, true);
  assert.equal(result.eventId, 1);
});

test('extractEventSlots finds a location and characters', () => {
  const slots = extractEventSlots('我推门进灯室，看见宁站在窗边。', { characters: ['宁', 'Coo'] });
  assert.equal(slots.location, '灯室');
  assert.deepEqual(slots.characters, ['宁']);
});

test('invalid slots are rejected without changing event state', () => {
  const check = validateEventSlots({ location: 42, characters: '宁', bad: true });
  assert.equal(check.ok, false);
  const state = new EventModelState({ slots: base });
  const result = state.observe({ slots: { location: 42 } });
  assert.equal(result.boundary, false);
  assert.equal(result.error, 'invalid-slots');
  assert.deepEqual(state.slots.location, '灯室');
});
