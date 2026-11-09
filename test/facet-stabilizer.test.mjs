import assert from 'node:assert/strict';
import test from 'node:test';
import { lexicalFacet, stabilizeFacets } from '../src/memory/facet-stabilizer.mjs';

const records = [
  { turn: 1, facets: { activity: '开发', topic: '技术' } },
  { turn: 2, facets: { activity: '开发', topic: '技术' } },
  { turn: 3, facets: { activity: '跑团', topic: '剧情' } },
];

test('start marker overrides a noisy local head', () => {
  assert.deepEqual(lexicalFacet('TRPG 开一把'), { activity: '跑团', source: 'start-marker' });
  const result = stabilizeFacets({
    raw: { facets: { activity: '开发', topic: '技术' }, confidence: { activity: 0.4, topic: 0.5 } },
    text: 'TRPG 开一把',
    records,
  });
  assert.equal(result.facets.activity, '跑团');
  assert.equal(result.reason, 'start-marker');
});

test('retrieval votes correct a noisy local head', () => {
  const result = stabilizeFacets({
    raw: { facets: { activity: '跑团', topic: '剧情' }, confidence: { activity: 0.33, topic: 0.4 } },
    text: '更新 README',
    records,
    keyword: [{ turn: 1 }, { turn: 2 }],
    semantic: [{ turn: 1 }, { turn: 2 }],
  });
  assert.equal(result.facets.activity, '开发');
});

test('summary only corroborates, it does not override', () => {
  const result = stabilizeFacets({
    raw: { facets: { activity: '开发', topic: '技术' }, confidence: { activity: 0.8, topic: 0.8 } },
    text: '天气',
    records,
    keyword: [{ turn: 1 }, { turn: 2 }],
    semantic: [{ turn: 1 }],
    summary: [{ turn: 3 }],
  });
  assert.equal(result.facets.activity, '开发');
  assert.equal(result.summaryAgrees, false);
});
