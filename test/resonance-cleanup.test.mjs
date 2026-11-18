import test from 'node:test';
import assert from 'node:assert/strict';
import * as query from '../src/turn-ping/query.mjs';
import { memoryCueMessage, retiredMemoryCueMessage, isMemoryCueMessage } from '../src/memory-cue.mjs';
import { classifyLegacyCue } from '../src/legacy-cue-audit.mjs';

test('legacy aliases are removed; production cue predicate accepts only memory-cue', () => {
  assert.equal(query.turnPingMessage, undefined);
  assert.equal(query.retiredTurnPingMessage, undefined);
  assert.equal(isMemoryCueMessage(memoryCueMessage('x')), true);
  assert.equal(isMemoryCueMessage(retiredMemoryCueMessage()), false);
  assert.equal(isMemoryCueMessage({ source: { kind: 'turn-ping-memory' }, content: [{ type: 'text', text: 'x' }] }), false);
});

test('read-only audit distinguishes legacy active and retirement tombstone', () => {
  assert.equal(classifyLegacyCue({ source: { kind: 'turn-ping-memory' } }), 'active-legacy');
  assert.equal(classifyLegacyCue({ source: { kind: 'turn-ping-retired' } }), 'retired-legacy');
  assert.equal(classifyLegacyCue({ source: { kind: 'memory-cue' } }), 'not-legacy');
  assert.equal(classifyLegacyCue({ source: { kind: 'memory-cue-retired' } }), 'not-legacy');
});
