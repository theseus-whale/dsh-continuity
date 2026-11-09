import assert from 'node:assert/strict';
import test from 'node:test';
import { matchSpecialKeywords, parseSpecialKeywords } from '../src/memory/special-keywords.mjs';
import { makeRecord, retrieve } from '../src/memory/bc-recall.mjs';

test('special keyword matching is exact for Latin names', () => {
  const words = ['Coo', 'Continuity'];
  assert.deepEqual(matchSpecialKeywords('Coo 的编程问题', words), ['Coo']);
  assert.deepEqual(matchSpecialKeywords('Cool 不是 Coo', words), ['Coo']);
  assert.deepEqual(matchSpecialKeywords('Continuous', words), []);
});

test('special keyword plus facet narrows retrieval', () => {
  const records = [
    makeRecord({ turn: 1, seqStart: 1, seqEnd: 1, generic: ['技术'], keywords: ['coo', '代码'] }),
    makeRecord({ turn: 2, seqStart: 2, seqEnd: 2, generic: ['游戏'], keywords: ['coo', '跑团'] }),
    makeRecord({ turn: 3, seqStart: 3, seqEnd: 3, generic: ['技术'], keywords: ['continuity'] }),
  ];
  const result = retrieve({ records, query: '技术', specialKeywords: ['Coo'] });
  assert.equal(result.kind, 'recall');
  assert.equal(result.via, 'K');
  assert.deepEqual(result.hits.map((hit) => hit.turn), [1]);
});

test('keyword list parser ignores comments and blanks', () => {
  assert.deepEqual(parseSpecialKeywords('# names\nCoo\n\nContinuity\n'), ['Coo', 'Continuity']);
});
