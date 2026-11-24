import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bestWithinWindow,
  buildChunkTimeline,
  cosineSimilarity,
  earliestAboveThreshold,
  resolveAnchor,
  scoreDirectionalCandidates,
  thresholdSweep,
} from '../src/fullseed/continuation-shadow.mjs';

const chunk = (id, start, end, vector, chunkIndex = 0, summaryText = `摘要 ${id}`) => ({
  chunkId: id,
  turnId: `turn-${start}`,
  chunkIndex,
  seqStart: start,
  seqEnd: end,
  summaryText,
  concreteNouns: [],
});

test('timeline keeps summaries paired with vectors while sorting chronologically', () => {
  const timeline = buildChunkTimeline([
    chunk('later', 20, 21, [0, 1]),
    chunk('early', 10, 11, [1, 0]),
  ], [[0, 1], [1, 0]]);
  assert.deepEqual(timeline.map((row) => row.chunkId), ['early', 'later']);
  assert.deepEqual(timeline[1].vector, [0, 1]);
});

test('next scores every later block in time order and separately records semantic rank', () => {
  const timeline = buildChunkTimeline([
    chunk('a', 10, 11, [1, 0]),
    chunk('b', 12, 13, [0.8, 0.2]),
    chunk('c', 14, 15, [0, 1]),
  ], [[1, 0], [0.8, 0.2], [0, 1]]);
  const scored = scoreDirectionalCandidates(timeline, timeline[0]);
  assert.deepEqual(scored.map((row) => row.chunkId), ['b', 'c']);
  assert.deepEqual(scored.map((row) => row.semanticRank), [1, 2]);
  assert.deepEqual(scored.map((row) => row.ordinalGap), [1, 2]);
});

test('prev reverses the search direction without changing pair cosine', () => {
  const timeline = buildChunkTimeline([
    chunk('a', 10, 11, [1, 0]),
    chunk('b', 12, 13, [0.8, 0.2]),
    chunk('c', 14, 15, [0, 1]),
  ], [[1, 0], [0.8, 0.2], [0, 1]]);
  const next = scoreDirectionalCandidates(timeline, timeline[0], { direction: 'next' })[0];
  const prev = scoreDirectionalCandidates(timeline, timeline[1], { direction: 'prev' })[0];
  assert.equal(prev.chunkId, 'a');
  assert.equal(prev.cosine, next.cosine);
});

test('split chunks sharing one seq remain distinct and follow chunkIndex', () => {
  const timeline = buildChunkTimeline([
    chunk('second', 337, 337, [0, 1], 2),
    chunk('first', 337, 337, [1, 0], 1),
    chunk('before', 335, 335, [0.5, 0.5], 0),
  ], [[0, 1], [1, 0], [0.5, 0.5]]);
  assert.deepEqual(timeline.map((row) => row.chunkId), ['before', 'first', 'second']);
  const scored = scoreDirectionalCandidates(timeline, timeline[1]);
  assert.deepEqual(scored.map((row) => row.chunkId), ['second']);
});

test('seq alone is rejected as ambiguous when a long event has multiple chunks', () => {
  const timeline = buildChunkTimeline([
    chunk('first', 337, 337, [1, 0], 1),
    chunk('second', 337, 337, [0, 1], 2),
  ], [[1, 0], [0, 1]]);
  assert.throws(() => resolveAnchor(timeline, { seqStart: 337 }), /ambiguous/);
  assert.equal(resolveAnchor(timeline, { seqStart: 337, chunkIndex: 2 }).chunkId, 'second');
});

test('no threshold means no selected continuation; a threshold selects earliest pass, not global maximum', () => {
  const timeline = buildChunkTimeline([
    chunk('a', 10, 11, [1, 0]),
    chunk('b', 12, 13, [0.8, 0.2]),
    chunk('c', 14, 15, [0.9, 0.1]),
  ], [[1, 0], [0.8, 0.2], [0.9, 0.1]]);
  const scored = scoreDirectionalCandidates(timeline, timeline[0]);
  assert.equal(earliestAboveThreshold(scored), null);
  assert.equal(earliestAboveThreshold(scored, 0.96).chunkId, 'b');
  assert.equal(earliestAboveThreshold(scored, 0.98).chunkId, 'c');
  assert.equal(earliestAboveThreshold(scored, 0.995), null);
});

test('cosine normalizes vectors and handles zero vectors', () => {
  assert.ok(Math.abs(cosineSimilarity([2, 0], [3, 0]) - 1) < 1e-12);
  assert.equal(cosineSimilarity([0, 0], [1, 0]), 0);
  assert.throws(() => cosineSimilarity([1], [1, 0]), /dimensions/);
});

test('threshold sweep reports confusion counts and ranking metrics', () => {
  const sweep = thresholdSweep([
    { cosine: 0.9, label: 1 },
    { cosine: 0.8, label: 0 },
    { cosine: 0.7, label: 1 },
    { cosine: 0.2, label: 0 },
  ]);
  const between = sweep.find((row) => row.threshold > 0.7 && row.threshold < 0.8);
  assert.deepEqual([between.tp, between.fp, between.tn, between.fn], [1, 1, 1, 1]);
  assert.equal(between.precision, 0.5);
  assert.equal(between.recall, 0.5);
  assert.equal(between.falsePositiveRate, 0.5);
});

test('bounded windows choose the highest cosine, not the nearest block', () => {
  const scored = [
    { chunkId: 'near', ordinalGap: 1, cosine: 0.4 },
    { chunkId: 'edge5', ordinalGap: 5, cosine: 0.8 },
    { chunkId: 'inside10', ordinalGap: 9, cosine: 0.9 },
    { chunkId: 'outside20', ordinalGap: 21, cosine: 1 },
  ];
  assert.equal(bestWithinWindow(scored, 5).chunkId, 'edge5');
  assert.equal(bestWithinWindow(scored, 10).chunkId, 'inside10');
  assert.equal(bestWithinWindow(scored, 20).chunkId, 'inside10');
  assert.equal(bestWithinWindow(scored, 30).chunkId, 'outside20');
});

test('bounded windows prefer the nearest block on equal cosine and allow no match', () => {
  const scored = [
    { chunkId: 'far', ordinalGap: 6, cosine: 0.8 },
    { chunkId: 'near', ordinalGap: 2, cosine: 0.8 },
  ];
  assert.equal(bestWithinWindow(scored, 10).chunkId, 'near');
  assert.equal(bestWithinWindow(scored, 1), null);
  assert.equal(bestWithinWindow([], 20), null);
  assert.throws(() => bestWithinWindow(scored, 0), /positive integer/);
});

test('directional limit scans only the nearest twenty blocks', () => {
  const summaries = [chunk('anchor', 0, 0, [1, 0])];
  const vectors = [[1, 0]];
  for (let index = 1; index <= 22; index += 1) {
    summaries.push(chunk(`c${index}`, index, index, index === 21 ? [1, 0] : [0, 1]));
    vectors.push(index === 21 ? [1, 0] : [0, 1]);
  }
  const timeline = buildChunkTimeline(summaries, vectors);
  const scored = scoreDirectionalCandidates(timeline, timeline[0], { limit: 20 });
  assert.equal(scored.length, 20);
  assert.equal(scored.at(-1).chunkId, 'c20');
  assert.equal(scored.some((row) => row.chunkId === 'c21'), false);
  assert.equal(scoreDirectionalCandidates(timeline, timeline[0], { limit: 0 }).length, 0);
});
