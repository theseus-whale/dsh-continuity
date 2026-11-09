import assert from 'node:assert/strict';
import test from 'node:test';
import { createCMap, groupHits, learnTerm, makeRecord, retrieve, widthWarning } from '../src/memory/bc-recall.mjs';

test('exact K name is narrower than a C concept expansion', () => {
  const records = [
    makeRecord({ turn: 58003, seqStart: 58003, seqEnd: 58003, text: '', generic: [], terms: [], keywords: ['lts版'] }),
    ...Array.from({ length: 25 }, (_, index) => makeRecord({
      turn: 100 + index * 100,
      seqStart: 100 + index * 100,
      seqEnd: 100 + index * 100,
      text: '',
      generic: ['技术'],
      terms: ['LTS'],
      keywords: [],
    })),
  ];
  const cmap = createCMap([{ term: 'LTS', generic: ['技术'], minB: 0, limit: 25 }]);
  const k = retrieve({ records, cmap, query: 'LTS版', specialKeywords: ['LTS版'] });
  const c = retrieve({ records, cmap, query: 'LTS' });
  assert.equal(k.via, 'K');
  assert.equal(k.hits.length, 1);
  assert.equal(c.via, 'C');
  assert.equal(c.hits.length, 25);
  assert.ok(groupHits(k.hits).length < groupHits(c.hits).length);
  assert.match(widthWarning(c, groupHits(c.hits)), /C 映射/);
  assert.equal(widthWarning(k, groupHits(k.hits)), null);
});
