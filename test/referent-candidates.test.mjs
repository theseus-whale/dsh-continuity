import assert from 'node:assert/strict';
import test from 'node:test';
import { candidateReferents, bindReferent } from '../src/memory/referent-candidates.mjs';

const records = [
  { turn: 1, text: '星港开场', facets: { activity: '跑团' } },
  { turn: 2, text: '写插件', facets: { activity: '开发' } },
  { turn: 3, text: '回到星港', facets: { activity: '跑团' } },
];

test('known alias becomes a referent candidate', () => {
  const candidates = candidateReferents({ term: 'TRPG', records });
  assert.equal(candidates[0].referent, 'facet:跑团');
  assert.equal(bindReferent(candidates).referent, 'facet:跑团');
});

test('exact event-log occurrences become candidates', () => {
  const candidates = candidateReferents({ term: '星港', records });
  assert.ok(candidates.some((item) => item.referent === 'turn:1'));
  assert.ok(candidates.some((item) => item.referent === 'turn:3'));
  assert.equal(bindReferent(candidates).referent, 'turn:1');
});

test('no evidence returns NIL', () => {
  const candidates = candidateReferents({ term: '不存在', records });
  assert.deepEqual(candidates, []);
  assert.equal(bindReferent(candidates).referent, 'NIL');
});

test('retrieval-only candidate below threshold is NIL', () => {
  const candidates = candidateReferents({
    term: '星港',
    records,
    semanticHits: [{ turn: 3 }],
  });
  const bound = bindReferent(candidates, { threshold: 0.9 });
  assert.equal(bound.referent, 'NIL');
});
