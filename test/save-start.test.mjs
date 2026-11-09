import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSaveStart, detectSkippedRange } from '../src/save-start.mjs';

test('explicit start below surface folds from surface and reports belowSurface', () => {
  assert.deepEqual(resolveSaveStart({ explicitFrom: 46211, surfaceFirst: 46723 }), {
    startFrom: 46723,
    belowSurface: true,
  });
});

test('explicit start at/above surface is kept; no explicit starts at surface', () => {
  assert.deepEqual(resolveSaveStart({ explicitFrom: 46723, surfaceFirst: 46723 }), {
    startFrom: 46723,
    belowSurface: false,
  });
  assert.deepEqual(resolveSaveStart({ explicitFrom: 48000, surfaceFirst: 46723 }), {
    startFrom: 48000,
    belowSurface: false,
  });
  assert.deepEqual(resolveSaveStart({ surfaceFirst: 46723 }), {
    startFrom: 46723,
    belowSurface: false,
  });
});

test('detectSkippedRange counts only message events inside the hole', () => {
  const events = [
    { seq: 46203, type: 'step/start' },
    { seq: 46211, type: 'user/message' },
    { seq: 46216, type: 'assistant/message' },
    { seq: 46220, type: 'tool/call' },
    { seq: 46719, type: 'tool/result' },
    { seq: 46723, type: 'user/message' },
  ];
  assert.deepEqual(detectSkippedRange({ coveredTo: 46202, surfaceFirst: 46723, events }), {
    from: 46203,
    to: 46722,
    events: 2,
  });
});

test('no hole returns null; empty range returns null', () => {
  assert.equal(detectSkippedRange({ coveredTo: 46722, surfaceFirst: 46723, events: [] }), null);
  assert.equal(detectSkippedRange({ coveredTo: 0, surfaceFirst: 1, events: [] }), null);
  assert.equal(detectSkippedRange({
    coveredTo: 10,
    surfaceFirst: 15,
    events: [{ seq: 11, type: 'step/start' }, { seq: 12, type: 'turn/end' }],
  }), null);
});
