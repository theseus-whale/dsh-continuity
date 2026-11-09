import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreEntities, aggregateScores } from '../src/memory/extraction-score.mjs';

test('exact entity match computes precision and recall', () => {
  const score = scoreEntities(
    [{ text: '灯室', label: 'LOC' }, { text: '宁', label: 'PERSON' }, { text: '错', label: 'MISC' }],
    [{ text: '灯室', label: 'LOC' }, { text: '宁', label: 'PERSON' }, { text: '钥匙', label: 'OBJECT' }],
  );
  assert.deepEqual(score, { tp: 2, fp: 1, fn: 1, precision: 0.6667, recall: 0.6667, f1: 0.6667 });
});

test('aggregate scores are micro-averaged', () => {
  const a = scoreEntities([{ text: 'A', label: 'PERSON' }], [{ text: 'A', label: 'PERSON' }]);
  const b = scoreEntities([], [{ text: 'B', label: 'LOC' }]);
  const total = aggregateScores([a, b]);
  assert.equal(total.tp, 1);
  assert.equal(total.fp, 0);
  assert.equal(total.fn, 1);
  assert.equal(total.precision, 1);
  assert.equal(total.recall, 0.5);
});
