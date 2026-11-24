import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChunkPing } from '../src/fullseed/ping.mjs';

const config = { retrieval: { maxSummariesPerFacet: 4, maxPingUtf8Bytes: 16384 } };
const chunk = (id, start, end, availableCutoff = end) => ({
  chunkId: `chunk-${id}`,
  turnId: `turn-${id}`,
  seqStart: start,
  seqEnd: end,
  availableCutoff,
  summaryText: `摘要-${id}`,
});
const recall = (summaries, hitId, cutoff = 100) => buildChunkPing({
  summaries,
  scored: [{ chunkId: `chunk-${hitId}`, score: 1 }],
  cutoff,
  config,
}).text;

test('middle HIT gets compact previous and next seq ranges without neighbor text', () => {
  const text = recall([chunk('next', 41, 48), chunk('hit', 32, 35), chunk('prev', 10, 20)], 'hit');
  assert.match(text, /  nav: prev 10-20 · next 41-48/);
  assert.doesNotMatch(text, /摘要-(?:prev|next)/);
  assert.doesNotMatch(text, /nav:.*turn-|nav:.*chunk-/);
});

test('first and last HITs omit missing directions instead of printing none', () => {
  const first = recall([chunk('a', 10, 20), chunk('b', 30, 40)], 'a');
  assert.match(first, /  nav: next 30-40/);
  assert.doesNotMatch(first, /prev|none/);

  const last = recall([chunk('a', 10, 20), chunk('b', 30, 40)], 'b');
  assert.match(last, /  nav: prev 10-20/);
  assert.doesNotMatch(last, /next|none/);
});

test('single available chunk has no navigation line', () => {
  const text = recall([chunk('only', 10, 20)], 'only');
  assert.doesNotMatch(text, /  nav:/);
});

test('navigation never crosses the active cutoff', () => {
  const text = recall([
    chunk('prev', 10, 20),
    chunk('hit', 30, 35),
    chunk('future', 40, 50),
  ], 'hit', 35);
  assert.match(text, /  nav: prev 10-20/);
  assert.doesNotMatch(text, /next|40-50/);
});

test('a bounded summary view cannot navigate beyond that view', () => {
  const eligibleBeforeBound = [chunk('prev', 10, 20), chunk('hit', 30, 35)];
  const text = recall(eligibleBeforeBound, 'hit', 100);
  assert.match(text, /  nav: prev 10-20/);
  assert.doesNotMatch(text, /next/);
});
