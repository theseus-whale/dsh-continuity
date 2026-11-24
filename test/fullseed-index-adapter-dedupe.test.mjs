import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUnifiedIndexAdapter } from '../src/fold/index-adapter.mjs';
import { activate, loadMergedIndex, readActive, writeBase } from '../src/fullseed/storage.mjs';
import { turnPingRoot } from '../src/turn-ping/storage.mjs';

const summary = (chunkId, text, seq) => ({
  chunkId,
  turnId: `turn-${String(seq).padStart(6, '0')}`,
  chunkIndex: 0,
  seqStart: seq,
  seqEnd: seq,
  summaryText: text,
  summarySha256: `sha-${text}`,
});

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fullseed-adapter-dedupe-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sessionId = 'session-test';
  const root = path.join(turnPingRoot({ home, sessionId }), 'fullseed');
  writeBase(root, { baseId: 'base', summaries: [summary('a', 'old', 1)], vectors: [[1, 0]], identity: 'test', checkpoint: 1, snapshotBoundary: 1 });
  activate(root, { baseId: 'base', identity: 'test', checkpoint: 1, snapshotBoundary: 1 });
  const adapter = createUnifiedIndexAdapter({ home, sessionId, storage: { appendLedger: async () => {} }, config: {} });
  return { root, adapter };
}

test('fullseed fold commit skips an identical active chunk and appends only the new chunk', async (t) => {
  const { root, adapter } = fixture(t);
  const result = await adapter.commitBatch([
    { source: 'generated', summary: summary('a', 'old', 1), vector: [1, 0] },
    { source: 'generated', summary: summary('b', 'new', 2), vector: [0, 1] },
  ], { compactionId: 'fold-dedupe', cutoff: 2 });
  const active = readActive(root);
  const merged = loadMergedIndex(root, active);
  assert.equal(result.deltaId.startsWith('fold-fold-dedupe-'), true);
  assert.deepEqual(merged.summaries.map((row) => row.chunkId), ['a', 'b']);
  assert.equal(active.checkpoint, 2);
});

test('fullseed fold commit is a no-op when every generated chunk is already active', async (t) => {
  const { root, adapter } = fixture(t);
  const result = await adapter.commitBatch([
    { source: 'generated', summary: summary('a', 'old', 1), vector: [1, 0] },
  ], { compactionId: 'fold-noop', cutoff: 2 });
  assert.equal(result.deltaId, null);
  assert.deepEqual(loadMergedIndex(root, readActive(root)).summaries.map((row) => row.chunkId), ['a']);
});

test('fullseed fold commit rejects conflicting content for an active chunkId', async (t) => {
  const { root, adapter } = fixture(t);
  await assert.rejects(() => adapter.commitBatch([
    { source: 'generated', summary: summary('a', 'changed', 1), vector: [1, 0] },
  ], { compactionId: 'fold-conflict', cutoff: 2 }), /conflicting active chunkId a/);
  assert.equal(readActive(root).checkpoint, 1);
});
