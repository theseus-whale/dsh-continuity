import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIdentity } from '../src/fullseed/seed.mjs';
import { writeBase, activate } from '../src/fullseed/storage.mjs';
import { clearActiveCache } from '../src/fullseed/cache.mjs';
import { processIncrement, enqueueTurnStopping, installEngineTurnStopping, readQueue } from '../src/fullseed/worker.mjs';
import { createFullseedWorker } from '../src/fullseed/runtime.mjs';
import { buildRawChunks } from '../src/fullseed/chunks.mjs';
import { buildChunkSummary } from '../src/fullseed/summary.mjs';
import { buildTurnsFromEvents } from '../src/turn-ping/host.mjs';
import { createTurnPingStorage, turnPingRoot } from '../src/turn-ping/storage.mjs';
import { createUnifiedIndexAdapter } from '../src/fold/index-adapter.mjs';
import { createUnifiedFoldBatch } from '../src/fold/unified-fold.mjs';

const SID = 'session-turn-end';
const vec = () => Array.from({ length: 512 }, (_, i) => i === 0 ? 1 : 0);
const identity = buildIdentity({ promptTextSha256: 'p', extractionRuleSha256: 'e' });
const config = () => ({
  summary: { maxAttempts: 1, promptVersion: 'test', provider: 'fake', model: 'fake' },
  sourceView: { userChars: 4000, assistantChars: 5000, toolChars: 1500, totalChars: 16000, userSourceKinds: ['user', 'peer'] },
  vector: { model: 'BGE', dimensions: 512 },
});
function peer(seq, text) { return { seq, type: 'user/message', data: { message: { source: { kind: 'peer' }, content: [{ type: 'text', text }] } } }; }
function assistant(seq, text) { return { seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }; }
function marker(seq, type, turn) { return { seq, type, data: { turn } }; }
function rootFor(home) { return path.join(turnPingRoot({ home, sessionId: SID }), 'fullseed'); }
function sessionFor(events, nodes) {
  return { id: SID, surface: { nodes }, eventAt: (seq) => events.find((event) => event.seq === seq), snapshotEvents: () => [...events] };
}
function foldBatch({ home, events, nodes, calls }) {
  const storage = createTurnPingStorage({ home, sessionId: SID });
  return createUnifiedFoldBatch({
    sessionId: SID, session: sessionFor(events, nodes), start: nodes[0], end: nodes.at(-1), events,
    turns: buildTurnsFromEvents(SID, events), config: config(), storage,
    indexAdapter: createUnifiedIndexAdapter({ home, sessionId: SID, storage, config: config() }),
    provider: async () => { calls.n += 1; return { text: 'fold must reuse', provider: 'fake', model: 'fake' }; },
    embedder: async () => vec(), stagingDir: null,
  });
}

test('turn-end archival produces a Host-turn delta and fold reuses it with zero model calls', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-end-archival-'));
  const root = rootFor(home);
  writeBase(root, { baseId: 'empty', summaries: [], vectors: [], identity, checkpoint: 0, snapshotBoundary: 0 });
  activate(root, { baseId: 'empty', identity, checkpoint: 0, snapshotBoundary: 0, pending: 0 });
  clearActiveCache();
  const events = [
    marker(1, 'turn/start', 1), peer(2, 'peer one'), peer(3, 'peer two'), assistant(4, 'answer'), marker(5, 'turn/end', 1),
    marker(6, 'turn/start', 2), peer(7, 'still open'), assistant(8, 'not ready'),
  ];
  let calls = 0;
  const archived = await processIncrement({
    root, sessionId: SID, events, watermark: 0, identity,
    provider: async () => { calls += 1; return { text: '完整轮摘要', provider: 'fake', model: 'fake' }; },
    embedder: async () => vec(),
  });
  assert.equal(calls, 1);
  assert.equal(archived.chunks, 1);
  assert.equal(archived.active.checkpoint, 5);
  assert.equal(archived.delta.manifest.summaries, 1);
  assert.equal(archived.delta.manifest.vectors, 1);

  const foldCalls = { n: 0 };
  const fold = foldBatch({ home, events, nodes: [2, 3, 4], calls: foldCalls });
  const out = await fold.summarize();
  assert.equal(foldCalls.n, 0);
  assert.equal(out.summary.length, 1);
  assert.match(out.summary[0].text, /完整轮摘要/);
  const committed = await fold.commit({ compactionId: 'fold-after-worker' });
  assert.equal(committed.committed, true);

  enqueueTurnStopping({ root, sessionId: SID, turn: { turn: 1 } });
  const worker = createFullseedWorker({
    home, sessionQuery: { readSession: async () => ({ events }) },
    provider: async () => { throw new Error('covered work must not call provider'); },
    embedder: async () => vec(), identity, allowedSessionIds: new Set([SID]), intervalMs: 60_000,
  });
  await worker.ready;
  worker.stop();
  assert.equal(readQueue(root).at(-1).status, 'done');
  assert.equal(readQueue(root).at(-1).chunks, 0);
});

test('complete long-turn chunks are all reused without another provider call', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-end-long-'));
  const root = rootFor(home);
  const events = [marker(1, 'turn/start', 1), peer(2, 'u'), assistant(3, 'abcdefghijklmnopqrstuvwxy'), marker(4, 'turn/end', 1)];
  const { chunks } = buildRawChunks(SID, events, { maxChars: 10 });
  assert.ok(chunks.length >= 3);
  const summaries = chunks.map((chunk, index) => buildChunkSummary({ chunk, text: `L-${index}`, provider: 'fake', model: 'fake' }));
  writeBase(root, { baseId: 'long', summaries, vectors: chunks.map(vec), identity, checkpoint: 4, snapshotBoundary: 4 });
  activate(root, { baseId: 'long', identity, checkpoint: 4, snapshotBoundary: 4, pending: 0 });
  clearActiveCache();
  const calls = { n: 0 };
  const fold = foldBatch({ home, events, nodes: [2, 3], calls });
  const out = await fold.summarize();
  assert.equal(calls.n, 0);
  assert.equal(out.summary.length, chunks.length);
  assert.deepEqual(out.summary.map((block) => block.text.includes(`chunk=${chunks[0].chunkId}`) || chunks.some((chunk) => block.text.includes(`chunk=${chunk.chunkId}`))), chunks.map(() => true));
});

test('turn-stopping queue is stable, deduplicated and limited to allowed sessions', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-end-queue-'));
  const root = rootFor(home);
  const ctx = { on: (_name, fn) => { ctx.handler = fn; return () => {}; } };
  installEngineTurnStopping({ ctx, rootForSession: () => root, allowedSessionIds: new Set([SID]) });
  assert.equal((await ctx.handler({ agent: { session: { id: 'outsider' } }, turn: { turn: 1 } })).enqueued, false);
  assert.equal(fs.existsSync(path.join(root, 'increment-queue.jsonl')), false);
  const first = await ctx.handler({ agent: { session: { id: SID } }, turn: { turn: 7 } });
  const second = await ctx.handler({ agent: { session: { id: SID } }, turn: { turn: 7 } });
  assert.equal(first.enqueued, true);
  assert.equal(second.duplicate, true);
  assert.equal(first.queueId, second.queueId);
  assert.equal(readQueue(root).length, 1);
});

test('worker entry explicitly injects sessionQuery before worker creation', () => {
  const source = fs.readFileSync(new URL('../src/index.mjs', import.meta.url), 'utf8');
  assert.match(source, /export const inject = \['sessionQuery'\]/);
});
