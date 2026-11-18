import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTurnPingHost } from '../src/turn-ping/host.mjs';
import { turnPingRoot } from '../src/turn-ping/storage.mjs';
import { writeBase, writeDelta, activate } from '../src/fullseed/storage.mjs';
import { loadActiveIndex, clearActiveCache } from '../src/fullseed/cache.mjs';

const SID = 'session-adapter';
const vec = () => Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0));
const identity = 'identity-test';

function summary(chunkId, index, cutoff = 10) {
  return {
    sessionId: SID, turnId: 'turn-000001', chunkId, chunkIndex: index,
    seqStart: 1, seqEnd: 1, eventOffsets: [], rawTextSha256: 'r', rawRecordSha256: 'rr',
    sourceViewSha256: 's', firstFoldSeq: null, snapshotBoundary: 10, availableCutoff: cutoff,
    cutoffPolicy: 'activation-or-turn-end-v1', summaryText: `summary ${chunkId}`, summarySha256: `sha-${chunkId}`,
    provider: 'mock', model: 'mock', promptVersion: 'v2', promptTextSha256: 'p', extractionRuleSha256: 'e',
    status: 'complete', issues: [], attempts: [], usage: null,
  };
}

test('adapter uses production sessions/<id>/turn-ping/fullseed layout', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fullseed-adapter-'));
  const root = path.join(turnPingRoot({ home, sessionId: SID }), 'fullseed');
  const s1 = summary('c1', 0);
  writeBase(root, { baseId: 'b1', summaries: [s1], vectors: [vec()], identity, checkpoint: 10, snapshotBoundary: 10 });
  activate(root, { baseId: 'b1', identity, checkpoint: 10, snapshotBoundary: 10, pending: 0 });
  clearActiveCache();
  const host = createTurnPingHost({ home, config: { enabled: true, boundaries: { allowDefaultEnable: true } }, embedder: async () => vec() });
  const result = await host.beforeAnswer({ sessionId: SID, query: 'q', cutoff: 10, events: [] });
  assert.equal(result.enabled, true);
  assert.match(result.ping.text, /c1/);
  assert.equal(result.ping.hits.length, 1);
});

test('adapter does not merge chunks with same turnId', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fullseed-adapter-'));
  const root = path.join(turnPingRoot({ home, sessionId: SID }), 'fullseed');
  const chunks = [summary('c1', 0), summary('c2', 1)];
  writeBase(root, { baseId: 'b1', summaries: chunks, vectors: [vec(), vec()], identity, checkpoint: 10, snapshotBoundary: 10 });
  activate(root, { baseId: 'b1', identity, checkpoint: 10, snapshotBoundary: 10, pending: 0 });
  clearActiveCache();
  const host = createTurnPingHost({ home, config: { enabled: true, boundaries: { allowDefaultEnable: true } }, embedder: async () => vec() });
  const result = await host.beforeAnswer({ sessionId: SID, query: 'q', cutoff: 10, events: [] });
  assert.equal(result.ping.hits.length, 2);
  assert.match(result.ping.text, /c1/);
  assert.match(result.ping.text, /c2/);
});

test('adapter cache invalidates after active pointer/delta change', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fullseed-adapter-'));
  const root = path.join(turnPingRoot({ home, sessionId: SID }), 'fullseed');
  const s1 = summary('c1', 0);
  writeBase(root, { baseId: 'b1', summaries: [s1], vectors: [vec()], identity, checkpoint: 10, snapshotBoundary: 10 });
  activate(root, { baseId: 'b1', identity, checkpoint: 10, snapshotBoundary: 10, pending: 0 });
  const first = loadActiveIndex(root);
  assert.equal(first.merged.summaries.length, 1);
  const second = loadActiveIndex(root);
  assert.equal(first, second);
  writeDelta(root, { baseId: 'b1', deltaId: 'd1', summaries: [summary('c2', 1, 20)], vectors: [vec()], fromCheckpoint: 10, toCheckpoint: 20, identity });
  activate(root, { baseId: 'b1', deltaIds: ['d1'], identity, checkpoint: 20, snapshotBoundary: 10, pending: 0 });
  const third = loadActiveIndex(root);
  assert.notEqual(second, third);
  assert.equal(third.merged.summaries.length, 2);
});
