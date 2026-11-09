import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCoref } from '../src/memory/structured-adapters.mjs';
import { corefReferents, applyCorefToSlots } from '../src/memory/coref-slots.mjs';

const clusters = normalizeCoref([
  { mentions: [{ text: 'Coo', start: 0, end: 3, isCanonical: true }, { text: 'She', start: 27, end: 30 }] },
  { mentions: [{ text: 'coat', start: 45, end: 49, isCanonical: true }, { text: 'The coat', start: 55, end: 63 }] },
]);

test('coref referents map mentions to canonical', () => {
  const referents = corefReferents(clusters);
  assert.equal(referents[0].canonical, 'Coo');
  assert.deepEqual(referents[0].mentions, ['Coo', 'She']);
});

test('coref canonical names fill character slot', () => {
  const result = applyCorefToSlots({ characters: [], objects: [] }, clusters);
  assert.deepEqual(result.slots.characters, ['Coo']);
  assert.ok(result.slots.objects.includes('coat'));
});
