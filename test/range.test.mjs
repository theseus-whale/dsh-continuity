import test from 'node:test';
import assert from 'node:assert/strict';
import { selectOldestRange } from '../src/range.mjs';

const allBalanced = { balancedBefore: () => true, balancedAfter: () => true };

test('never starts on the system head', () => {
  const picked = selectOldestRange({
    surfaceSeqs: [10, 11, 12, 13],
    pricedTokens: [900, 100, 100, 100],
    systemHead: true,
    budget: 250,
    ...allBalanced,
  });
  assert.deepEqual(picked, { startIdx: 1, endIdx: 2, tokens: 200 });
});

test('accumulates the oldest prefix up to the budget', () => {
  const picked = selectOldestRange({
    surfaceSeqs: [0, 1, 2, 3, 4],
    pricedTokens: [10, 40, 40, 40, 40],
    budget: 90,
    ...allBalanced,
  });
  assert.equal(picked.startIdx, 0);
  assert.equal(picked.endIdx, 2);
  assert.equal(picked.tokens, 90);
});

test('stops before the protected tail', () => {
  const picked = selectOldestRange({
    surfaceSeqs: [0, 1, 2, 3, 4],
    pricedTokens: [10, 10, 10, 10, 10],
    budget: 50,
    tailFloor: 25,
    ...allBalanced,
  });
  // Two nodes may leave three behind (30 >= 25); three leave only 20.
  assert.equal(picked.endIdx, 1);
  assert.equal(picked.tokens, 20);
});

test('moves the end backwards to a balanced boundary', () => {
  const balanced = new Set([0, 1, 2]);
  const picked = selectOldestRange({
    surfaceSeqs: [0, 1, 2, 3, 4],
    pricedTokens: [10, 10, 10, 10, 10],
    budget: 40,
    ...allBalanced,
    balancedAfter: (seq) => balanced.has(seq),
  });
  assert.equal(picked.endIdx, 2);
  assert.equal(picked.tokens, 30);
});

test('returns null when no node fits the budget', () => {
  const picked = selectOldestRange({
    surfaceSeqs: [0, 1],
    pricedTokens: [500, 500],
    budget: 100,
    ...allBalanced,
  });
  assert.equal(picked, null);
});

test('returns null when only the system head exists', () => {
  const picked = selectOldestRange({
    surfaceSeqs: [0],
    pricedTokens: [500],
    systemHead: true,
    budget: 100,
    ...allBalanced,
  });
  assert.equal(picked, null);
});

test('returns null when the start cut is unbalanced', () => {
  const picked = selectOldestRange({
    surfaceSeqs: [0, 1, 2],
    pricedTokens: [10, 10, 10],
    budget: 30,
    balancedBefore: () => false,
    balancedAfter: () => true,
  });
  assert.equal(picked, null);
});

test('returns null when the balanced trailing cut falls before the start', () => {
  const picked = selectOldestRange({
    surfaceSeqs: [0, 1],
    pricedTokens: [10, 10],
    budget: 20,
    balancedBefore: () => true,
    balancedAfter: () => false,
  });
  assert.equal(picked, null);
});

test('treats missing priced tokens as zero and rejects a mismatched surface', () => {
  const picked = selectOldestRange({
    surfaceSeqs: [0, 1, 2],
    pricedTokens: [10, Number.NaN, 10],
    budget: 20,
    ...allBalanced,
  });
  assert.equal(picked.endIdx, 2);
  assert.equal(picked.tokens, 20);

  assert.equal(selectOldestRange({
    surfaceSeqs: [0, 1],
    pricedTokens: [10],
    budget: 20,
    ...allBalanced,
  }), null);
});
