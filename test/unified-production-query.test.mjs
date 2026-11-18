import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUnifiedFoldBatch } from '../src/fold/unified-fold.mjs';
import { createUnifiedIndexAdapter } from '../src/fold/index-adapter.mjs';
import { createTurnPingStorage } from '../src/turn-ping/storage.mjs';
import { createTurnPingHost } from '../src/turn-ping/host.mjs';
import { writeBase, activate } from '../src/fullseed/storage.mjs';
import { buildTurnsFromEvents } from '../src/turn-ping/host.mjs';

const vec = () => Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0));
const summary = (turn) => ({
  sessionId: 's', chunkId: turn.turnId, turnId: turn.turnId, seqStart: turn.seqStart, seqEnd: turn.seqEnd,
  rawTextSha256: turn.rawTextSha256, summaryText: `L-${turn.turnId}`, summarySha256: 'old-sha',
  availableCutoff: 2, blockText: 'old', blockSha256: 'old-block',
});
function fixture() {
  const events = [
    { seq: 1, type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: '历史问题' }] } } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '历史答案' }] } } },
  ];
  const session = { id: 's', surface: { nodes: [1, 2] }, snapshotEvents: () => [...events] };
  const turns = buildTurnsFromEvents('s', events);
  return { events, session, turns };
}
function config() { return { version: 'legacy-v1', summary: { maxAttempts: 1, hardMaxChars: 256, promptVersion: 'L', provider: 'fake', model: 'fake' }, sourceView: { userChars: 4000, assistantChars: 5000, toolChars: 1500, totalChars: 16000, userSourceKinds: ['user'] }, vector: { model: 'BGE', dimensions: 512 } }; }
async function fold({ home, sessionId, f, adapter = null }) {
  const store = createTurnPingStorage({ home, sessionId });
  const indexAdapter = createUnifiedIndexAdapter({ home, sessionId, storage: store, config: config() });
  const batch = createUnifiedFoldBatch({ sessionId, session: f.session, start: 1, end: 2, events: f.events, turns: f.turns, config: config(), storage: store, indexAdapter, provider: async ({ turn }) => ({ text: `L-${turn.turnId}`, provider: 'fake', model: 'fake' }), embedder: async () => vec(), stagingDir: null });
  await batch.summarize(); const commit = await batch.commit({ compactionId: 'fold-1' });
  assert.equal(commit.committed, true);
  return store;
}
async function answer(home, sessionId, f) {
  const host = createTurnPingHost({ home, config: { enabled: true, mode: 'opt-in', boundaries: { allowDefaultEnable: true } }, provider: async () => { throw new Error('unused'); }, embedder: async () => vec() });
  return host.beforeAnswer({ sessionId, query: '历史问题', cutoff: 2, events: f.events });
}

test('production legacy/fresh query reads unified vector records', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-prod-'));
  const f = fixture();
  await fold({ home, sessionId: 'fresh', f });
  const out = await answer(home, 'fresh', f);
  assert.equal(out.H >= 1, true);
  assert.match(out.ping.text, /folded|历史|L-/);
});

test('production Sonar legacy active query reads new fold records', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-sonar-'));
  const f = fixture();
  const store = createTurnPingStorage({ home, sessionId: 'sonar' });
  const old = summary(f.turns[0]);
  await store.appendSummary(old);
  await store.appendVector({ turnId: old.turnId, summarySha256: old.summarySha256, availableCutoff: 2, dimensions: 512, vector: vec(), vectorIndexVersion: 'legacy-v1' });
  await fold({ home, sessionId: 'sonar', f });
  const out = await answer(home, 'sonar', f);
  assert.equal(out.H >= 1, true);
});

test('production Continuity fullseed active query reads unified delta', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-fullseed-'));
  const f = fixture();
  const root = path.join(home, 'sessions', 'continuity', 'turn-ping', 'fullseed');
  const base = summary(f.turns[0]);
  writeBase(root, { baseId: 'base-old', summaries: [{ ...base, chunkId: base.turnId }], vectors: [vec()], identity: 'old', checkpoint: 2, snapshotBoundary: null });
  activate(root, { baseId: 'base-old', identity: 'old', checkpoint: 2, snapshotBoundary: null, pending: 0 });
  await fold({ home, sessionId: 'continuity', f });
  const out = await answer(home, 'continuity', f);
  assert.equal(out.H >= 1, true);
});

test('fullseed same turn with two chunks reuses both blocks/vectors, zero provider, query works', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-multichunk-'));
  const f = fixture();
  const root = path.join(home, 'sessions', 'continuity', 'turn-ping', 'fullseed');
  const base = summary(f.turns[0]);
  const a = { ...base, chunkId: 'chunk-a', summaryText: 'L-chunk-a', summarySha256: 'sha-a', seqStart: 1, seqEnd: 1, availableCutoff: 2 };
  const b = { ...base, chunkId: 'chunk-b', summaryText: 'L-chunk-b', summarySha256: 'sha-b', seqStart: 2, seqEnd: 2, availableCutoff: 2 };
  writeBase(root, { baseId: 'base-two', summaries: [a, b], vectors: [vec(), vec()], identity: 'old', checkpoint: 2, snapshotBoundary: null });
  activate(root, { baseId: 'base-two', identity: 'old', checkpoint: 2, snapshotBoundary: null, pending: 0 });
  const store = createTurnPingStorage({ home, sessionId: 'continuity' });
  const adapter = createUnifiedIndexAdapter({ home, sessionId: 'continuity', storage: store, config: config() });
  let providerCalls = 0;
  const batch = createUnifiedFoldBatch({ sessionId: 'continuity', session: f.session, start: 1, end: 2, events: f.events, turns: f.turns, config: config(), storage: store, indexAdapter: adapter, provider: async () => { providerCalls += 1; return { text: 'never', provider: 'fake', model: 'fake' }; }, embedder: async () => vec(), stagingDir: null });
  const out = await batch.summarize();
  assert.equal(providerCalls, 0);
  assert.equal(out.summary.length, 2);
  assert.deepEqual(out.summary.map((b) => b.text.includes('chunk-a') || b.text.includes('chunk-b')), [true, true]);
  assert.equal(batch.batch.records.length, 2);
  assert.equal(batch.batch.records.every((r) => r.vector === null), true);
  const before = await answer(home, 'continuity', f);
  assert.equal(before.H >= 1, true);
});
