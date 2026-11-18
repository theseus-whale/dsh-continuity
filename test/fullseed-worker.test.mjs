import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTurnPingHost } from '../src/turn-ping/host.mjs';
import { turnPingRoot } from '../src/turn-ping/storage.mjs';
import { writeBase, activate } from '../src/fullseed/storage.mjs';
import { clearActiveCache } from '../src/fullseed/cache.mjs';
import { enqueueTurnStopping, installEngineTurnStopping, processIncrement, startupReconcile, completedTurnsAfter } from '../src/fullseed/worker.mjs';
import { summarizeChunk } from '../src/fullseed/summary.mjs';
import { createFullseedLlmProvider } from '../src/fullseed/llm-adapter.mjs';

const SID = 'session-worker';
const vec = () => Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0));
const identity = buildIdentity({ promptTextSha256: 'p', extractionRuleSha256: 'e' });
import { buildIdentity } from '../src/fullseed/seed.mjs';

function ev(seq, role, text) {
  if (role === 'user') return { seq, type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text }] } } };
  return { seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } };
}

function oldSummary() {
  return {
    sessionId: SID, turnId: 'turn-000001', chunkId: 'old', chunkIndex: 0, seqStart: 1, seqEnd: 2,
    eventOffsets: [], rawTextSha256: 'r', rawRecordSha256: 'rr', sourceViewSha256: 's', firstFoldSeq: null,
    snapshotBoundary: 2, availableCutoff: 2, cutoffPolicy: 'activation-or-turn-end-v1',
    summaryText: 'old summary', summarySha256: 'so', provider: 'm', model: 'm', promptVersion: 'v2',
    promptTextSha256: 'p', extractionRuleSha256: 'e', status: 'complete', issues: [], attempts: [], usage: null,
  };
}

test('turn-stopping only enqueues, worker delta is retrievable, startup reconcile resumes', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fullseed-worker-'));
  const root = path.join(turnPingRoot({ home, sessionId: SID }), 'fullseed');
  writeBase(root, { baseId: 'b1', summaries: [oldSummary()], vectors: [vec()], identity, checkpoint: 2, snapshotBoundary: 2 });
  activate(root, { baseId: 'b1', identity, checkpoint: 2, snapshotBoundary: 2, pending: 0 });
  clearActiveCache();
  const events = [ev(1, 'user', 'one'), ev(2, 'assistant', 'two'), ev(3, 'user', 'three'), ev(4, 'assistant', 'four'), ev(5, 'user', 'five'), ev(6, 'assistant', 'six'), ev(7, 'user', 'active'), ev(8, 'assistant', 'tail')];
  let providerCalls = 0;
  const provider = async () => { providerCalls += 1; return { text: '三 四' }; };
  const embedder = async () => vec();
  const ctx = { agent: { session: { id: SID } }, on: (name, fn) => { ctx.handler = fn; return () => {}; } };
  installEngineTurnStopping({ ctx, root });
  await ctx.handler({ agent: { session: { id: SID } }, turn: { turn: 2 } });
  assert.equal(providerCalls, 0);
  assert.equal(fs.existsSync(path.join(root, 'increment-queue.jsonl')), true);
  const result = await processIncrement({ root, sessionId: SID, events, watermark: 2, provider, embedder, identity });
  assert.equal(result.chunks, 2);
  assert.ok(providerCalls >= 2);
  const host = createTurnPingHost({ home, config: { enabled: true, boundaries: { allowDefaultEnable: true } }, embedder });
  const answer = await host.beforeAnswer({ sessionId: SID, query: 'q', cutoff: 6, events: [] });
  assert.equal(answer.ping.hits.length, 3);
  assert.equal(answer.ping.hits.some((hit) => hit.availableCutoff === 6), true);
  const again = await startupReconcile({ root, sessionId: SID, events, provider, embedder, identity });
  assert.ok(again.skipped === 'empty-queue' || again.chunks === 0);
});

test('latest completed turn can be proven by turn/end without next user', () => {
  const done = completedTurnsAfter([ev(1, 'user', 'one'), ev(2, 'assistant', 'two'), { seq: 3, type: 'turn/end', data: { turn: { turn: 1 }, reason: { kind: 'ok' } } }], 0);
  assert.equal(done.length, 1);
  assert.equal(done[0].turnEndSeq, 3);
  const active = completedTurnsAfter([ev(1, 'user', 'one'), ev(2, 'assistant', 'two')], 0);
  assert.equal(active.length, 0);
});

test('structured LLM adapter normalizes JSON and records local weak nouns', async () => {
  const chunk = { chunkId: 'c1', rawText: '项目 Alpha 位于 12345', chars: 18 };
  const llm = { async *stream() { yield { type: 'text-delta', text: JSON.stringify({ chunkId: 'c1', L: 'Alpha 项目位于 12345。', concreteNouns: ['Alpha', '12345'] }) }; yield { type: 'usage', usage: { totalTokens: 9 } }; } };
  const provider = createFullseedLlmProvider({ llm, provider: 'p', model: 'm' });
  const summary = await summarizeChunk({ chunk, callProvider: provider });
  assert.equal(summary.status, 'complete');
  assert.equal(summary.chunkId, 'c1');
  assert.equal(summary.summaryText, 'Alpha 项目位于 12345。');
  assert.equal(summary.quality, 'weak-nouns');
  assert.equal(summary.concreteNouns.includes('Alpha'), true);
});
