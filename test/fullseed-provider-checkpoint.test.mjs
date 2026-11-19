import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeCheckpoint, MAX_FINITE_CHECKPOINT } from '../src/fullseed/checkpoint.mjs';
import { buildRawChunks } from '../src/fullseed/chunks.mjs';
import { runSeed } from '../src/fullseed/seed.mjs';
import { createTurnPingHost } from '../src/turn-ping/host.mjs';

const vec = () => Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0));

test('checkpoint must be finite for approved runs; activated fullseed is queryable at checkpoint', async () => {
  assert.equal(normalizeCheckpoint('Infinity'), MAX_FINITE_CHECKPOINT);
  assert.throws(() => normalizeCheckpoint('Infinity', { approve: true }), /finite/);
  const events = [{
    seq: 1,
    type: 'user/message',
    data: { message: { content: 'alpha original text', source: { kind: 'user' } } },
  }];
  const chunk = buildRawChunks('s', events, { checkpointSeq: 7639 }).chunks[0];
  assert.ok(chunk);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fullseed-checkpoint-'));
  const root = path.join(home, 'sessions', 's', 'turn-ping', 'fullseed');
  const result = await runSeed({
    chunks: [chunk],
    root,
    identity: 'checkpoint-test',
    checkpoint: 7639,
    snapshotBoundary: 7639,
    provider: async ({ chunkId }) => ({ chunkId, text: 'alpha summary', rawText: 'alpha summary' }),
    embedder: async () => vec(),
    maxProviderCalls: 1,
  });
  assert.equal(result.pending, 0);
  assert.equal(result.summaries[0].availableCutoff, 7639);
  assert.equal(result.active.checkpoint, 7639);
  const host = createTurnPingHost({ home, config: { enabled: true, mode: 'opt-in', boundaries: { allowDefaultEnable: true } }, embedder: async () => vec() });
  const answer = await host.beforeAnswer({ sessionId: 's', query: 'alpha', cutoff: 7639 });
  assert.equal(answer.enabled, true);
  assert.ok(answer.H >= 1);
  const active = JSON.parse(fs.readFileSync(path.join(root, 'active.json'), 'utf8'));
  assert.equal(active.checkpoint, 7639);
  assert.equal(active.pending, 0);
});
