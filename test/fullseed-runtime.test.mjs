import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeBase, activate } from '../src/fullseed/storage.mjs';
import { clearActiveCache } from '../src/fullseed/cache.mjs';
import { enqueueTurnStopping } from '../src/fullseed/worker.mjs';
import { createFullseedWorker } from '../src/fullseed/runtime.mjs';
import { buildIdentity } from '../src/fullseed/seed.mjs';
import { turnPingRoot } from '../src/turn-ping/storage.mjs';

const SID = 'session-runtime';
const vec = () => Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0));
const identity = buildIdentity({ promptTextSha256: 'p', extractionRuleSha256: 'e' });
function summary() {
  return { sessionId: SID, turnId: 'turn-000001', chunkId: 'old', chunkIndex: 0, seqStart: 1, seqEnd: 2, eventOffsets: [], rawTextSha256: 'r', rawRecordSha256: 'rr', sourceViewSha256: 's', firstFoldSeq: null, snapshotBoundary: 2, availableCutoff: 2, cutoffPolicy: 'activation-or-turn-end-v1', summaryText: 'old', summarySha256: 'so', provider: 'm', model: 'm', promptVersion: 'v2', promptTextSha256: 'p', extractionRuleSha256: 'e', status: 'complete', issues: [], attempts: [], usage: null };
}
function ev(seq, role, text) { return role === 'user' ? { seq, type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text }] } } } : { seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }; }

test('runtime worker consumes queue, writes delta and marks queue done', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fullseed-runtime-'));
  const root = path.join(turnPingRoot({ home, sessionId: SID }), 'fullseed');
  writeBase(root, { baseId: 'b1', summaries: [summary()], vectors: [vec()], identity, checkpoint: 2, snapshotBoundary: 2 });
  activate(root, { baseId: 'b1', identity, checkpoint: 2, snapshotBoundary: 2, pending: 0 });
  clearActiveCache();
  enqueueTurnStopping({ root, sessionId: SID, turn: 2 });
  const events = [ev(1, 'user', 'one'), ev(2, 'assistant', 'two'), ev(3, 'user', 'three'), ev(4, 'assistant', 'four'), ev(5, 'user', 'active')];
  let calls = 0;
  let reads = 0;
  const worker = createFullseedWorker({
    home, identity,
    sessionQuery: { async readSession() { reads += 1; return { events }; } },
    provider: async () => { calls += 1; return { text: '三 四' }; },
    embedder: async () => vec(),
  });
  const processed = await worker.ready;
  const callsAfter = calls;
  const readsAfter = reads;
  assert.ok(processed > 0);
  await worker.tick();
  assert.equal(calls, callsAfter);
  assert.equal(reads, readsAfter);
  worker.stop();
  const queue = fs.readFileSync(path.join(root, 'increment-queue.jsonl'), 'utf8').trim().split(/\n/).map(JSON.parse);
  assert.equal(queue.some((row) => row.status === 'done'), true);
});
