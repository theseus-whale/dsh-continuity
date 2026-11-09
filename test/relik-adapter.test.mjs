import assert from 'node:assert/strict';
import test from 'node:test';
import { relikToLinks } from '../src/memory/relik-adapter.mjs';

test('Relik output maps spans to entity links', () => {
  const links = relikToLinks({
    text: 'Michael Jordan was one of the best players in the NBA.',
    spans: [
      { start: 0, end: 14, text: 'Michael Jordan' },
      { start: 50, end: 53, text: 'NBA' },
    ],
    candidates: {
      span: [
        [[{ text: 'Michael Jordan', id: 4484083 }]],
        [[{ text: 'National Basketball Association', id: 5209815 }]],
      ],
    },
  });
  assert.equal(links.length, 2);
  assert.equal(links[0].referent, '4484083');
  assert.equal(links[1].referent, '5209815');
});

test('empty Relik candidate becomes NIL', () => {
  const links = relikToLinks({
    text: 'Unknown thing.',
    spans: [{ start: 0, end: 7, text: 'Unknown' }],
    candidates: { span: [[[]]] },
  });
  assert.equal(links[0].referent, 'NIL');
  assert.equal(links[0].entityId, null);
});
