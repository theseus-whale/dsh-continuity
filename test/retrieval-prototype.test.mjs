import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig } from '../src/turn-ping/config.mjs';
import { createTurnPingHost } from '../src/turn-ping/host.mjs';
import { createMemoryRecallTool } from '../src/turn-ping/memory-recall-tool.mjs';
import { decodeRecallCursor, readRetrievalPrototype, selectPrototypeHits } from '../src/turn-ping/retrieval-prototype.mjs';
import { writeBase, activate } from '../src/fullseed/storage.mjs';
import { clearActiveCache } from '../src/fullseed/cache.mjs';

const row = (id, seq, score, vector) => ({
  summary: { chunkId: id, turnId: `turn-${id}`, seqStart: seq, seqEnd: seq },
  score,
  vector,
});

function activateFixture(home, sessionId, rows, identity = 'prototype-index') {
  const root = path.join(home, 'sessions', sessionId, 'turn-ping', 'fullseed');
  const summaries = rows.map((entry, index) => ({
    sessionId,
    turnId: `turn-${String(entry.seq).padStart(6, '0')}`,
    chunkId: (index + 1).toString(16).padStart(64, '0'),
    chunkIndex: 0,
    seqStart: entry.seq,
    seqEnd: entry.seq,
    rawTextSha256: `raw-${entry.seq}`,
    rawRecordSha256: `record-${entry.seq}`,
    sourceViewSha256: `source-${entry.seq}`,
    availableCutoff: entry.seq,
    snapshotBoundary: 200,
    summaryText: entry.text,
  }));
  writeBase(root, {
    baseId: `base-${identity}`,
    summaries,
    vectors: rows.map(entry => entry.vector),
    identity,
    checkpoint: 200,
    snapshotBoundary: 200,
  });
  activate(root, { baseId: `base-${identity}`, identity, checkpoint: 200, snapshotBoundary: 200, pending: 0 });
  clearActiveCache();
}

const enabled = { enabled: true, boundaries: { allowDefaultEnable: true }, rawIndex: { enabled: false }, vector: { dimensions: 2 } };

test('prototype is default-off and temporal exploration preserves top/threshold and relevance', () => {
  assert.equal(readRetrievalPrototype({}).enabled, false);
  const config = readConfig({ retrieval: { prototype: { enabled: true } } });
  const recent = Array.from({ length: 12 }, (_, index) => row(`recent-${index}`, 100 + index, 0.96 - index * 0.001, [1, 0]));
  const old = row('old', 1, 0.85, [0, 1]);
  const irrelevant = row('irrelevant', 2, 0.44, [0, 1]);
  const selected = selectPrototypeHits({ scored: [...recent, old, irrelevant], config });
  assert.equal(selected.top, 0.96);
  assert.equal(selected.threshold, 0.88);
  assert.equal(selected.high.at(-1).summary.chunkId, 'old');
  assert.equal(selected.diagnostics.explorationCount, 1);
  assert.equal(selected.high.some(hit => hit.summary.chunkId === 'irrelevant'), false);

  const duplicate = selectPrototypeHits({ scored: [...recent, { ...old, vector: [0.99, 0.01] }], config });
  assert.equal(duplicate.high.some(hit => hit.summary.chunkId === 'old'), false);
});

test('fullseed full-library retrieval rescues an old relevant hit for manual and quiet recall', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-prototype-ab-'));
  const sessionId = 'prototype-ab';
  const rows = [
    { seq: 1, text: 'old-relevant', vector: [0.6, 0.8] },
    { seq: 2, text: 'old-irrelevant', vector: [0.3, Math.sqrt(0.91)] },
    ...Array.from({ length: 12 }, (_, index) => ({ seq: 100 + index, text: `recent-${index}`, vector: [1, 0] })),
  ];
  activateFixture(home, sessionId, rows);
  const embedder = async () => [1, 0];
  const baselineHost = createTurnPingHost({ home, config: enabled, embedder });
  const baseline = await baselineHost.beforeAnswer({ sessionId, query: '目标', cutoff: 200, events: [] });
  assert.equal(baseline.H, 12);
  assert.equal(baseline.ping.text.includes('old-relevant'), false);

  const prototypeHost = createTurnPingHost({
    home,
    config: { ...enabled, retrieval: { prototype: { enabled: true, candidatePool: 48 } } },
    embedder,
  });
  const prototype = await prototypeHost.beforeAnswer({ sessionId, query: '目标', cutoff: 200, events: [] });
  assert.equal(prototype.ping.text.includes('old-relevant'), true);
  assert.equal(prototype.ping.text.includes('old-irrelevant'), false);
  assert.equal(prototype.retrieval.prototype.candidateCount, 14);
  assert.equal(prototype.retrieval.prototype.explorationCount, 1);
  assert.equal(prototype.retrieval.top, 1);
  assert.ok(Math.abs(prototype.retrieval.threshold - 0.92) < 1e-12);

  const quiet = await prototypeHost.beforeAnswer({ sessionId, query: '上次的目标', cutoff: 200, events: [], quiet: true });
  assert.equal(quiet.H, 2);
  assert.equal(quiet.ping.text.includes('old-relevant'), true);
  assert.equal(quiet.ping.text.includes('old-irrelevant'), false);
  assert.equal(quiet.retrieval.prototype.totalCount, 14);
  assert.equal(quiet.retrieval.prototype.explorationCount, 1);
  assert.ok(Math.abs(quiet.retrieval.threshold - 0.96) < 1e-12);
  assert.equal('nextCursor' in quiet, false);

  const repeat = await prototypeHost.beforeAnswer({ sessionId, query: '上次的目标', cutoff: 200, events: [], quiet: true });
  assert.equal(repeat.H, 0);
  assert.equal(repeat.ping.text, '');
  assert.equal('nextCursor' in repeat, false);

  const before = await prototypeHost.beforeAnswer({ sessionId, query: '目标', cutoff: 200, events: [], beforeSeq: 50 });
  assert.equal(before.H, 1);
  assert.equal(before.ping.text.includes('old-relevant'), true);
  assert.equal(before.ping.text.includes('recent-0'), false);
  const empty = await prototypeHost.beforeAnswer({ sessionId, query: '目标', cutoff: 200, events: [], beforeSeq: 1 });
  assert.equal(empty.H, 0);
  assert.equal(empty.nextCursor, null);
});

test('cursor paginates without repeats across cutoff and checkpoint advancement', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-prototype-cursor-'));
  const sessionId = 'prototype-cursor';
  const scores = Array.from({ length: 20 }, (_, index) => 0.99 - index * 0.01);
  activateFixture(home, sessionId, scores.map((score, index) => ({
    seq: index + 1,
    text: `memory-${index + 1}`,
    vector: [score, Math.sqrt(1 - score * score)],
  })), 'cursor-index');
  const host = createTurnPingHost({
    home,
    config: { ...enabled, retrieval: { delta: 0.5, prototype: { enabled: true, candidatePool: 12, noveltyThreshold: 1 } } },
    embedder: async () => [1, 0],
  });
  const first = await host.beforeAnswer({ sessionId, query: '分页', cutoff: 200, events: [] });
  assert.equal(first.H, 4);
  assert.ok(first.nextCursor);
  assert.equal(first.retrieval.prototype.totalCount, 20);
  const decoded = decodeRecallCursor(first.nextCursor, { query: '分页', indexIdentity: 'cursor-index', beforeSeq: null });
  assert.equal(decoded.cutoff, 200);
  assert.equal(decoded.offset, 12);

  // Ordinary turns advance both values. Pagination must retain the first
  // query's snapshot instead of rejecting the cursor or admitting new rows.
  activate(path.join(home, 'sessions', sessionId, 'turn-ping', 'fullseed'), {
    baseId: 'base-cursor-index', identity: 'cursor-index', checkpoint: 201, snapshotBoundary: 200, pending: 0,
  });
  clearActiveCache();
  const second = await host.beforeAnswer({ sessionId, query: '分页', cutoff: 201, events: [], cursor: first.nextCursor });
  assert.equal(second.H, 4);
  assert.equal(second.retrieval.cutoff, 200);
  assert.equal(second.retrieval.requestedCutoff, 201);
  assert.equal(second.checkpoint, 201);
  assert.equal(second.retrieval.prototype.offset, 12);
  assert.equal(second.nextCursor, null);
  assert.equal(second.ping.text.includes('memory-13'), true);
  assert.equal(second.ping.text.includes('memory-16'), true);
  for (const seq of [1, 2, 3, 4]) assert.equal(second.ping.text.includes(`｜memory-${seq}｜seq`), false);
  await assert.rejects(() => host.beforeAnswer({ sessionId, query: '另一个问题', cutoff: 202, events: [], cursor: first.nextCursor }), /cursor does not match/);
  await assert.rejects(() => host.beforeAnswer({ sessionId, query: '分页', cutoff: 202, events: [], cursor: first.nextCursor, beforeSeq: 7 }), /cursor does not match/);
});

test('full ranking rescues rank-60 temporal target and paginates beyond 48 without repeating it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-prototype-full-ranking-'));
  const sessionId = 'prototype-full-ranking';
  const recent = Array.from({ length: 59 }, (_, index) => {
    const score = 0.99 - index * 0.005;
    return { seq: 1000 + index, text: `recent-rank-${index + 1}`, vector: [score, Math.sqrt(1 - score * score)] };
  });
  activateFixture(home, sessionId, [...recent, { seq: 1, text: 'old-rank-60', vector: [0.6, 0.8] }], 'full-ranking-index');
  const host = createTurnPingHost({
    home,
    config: { ...enabled, retrieval: { prototype: { enabled: true, noveltyThreshold: 1 } } },
    embedder: async () => [1, 0],
  });
  const first = await host.beforeAnswer({ sessionId, query: '全库', cutoff: 2000, events: [] });
  assert.equal(first.retrieval.prototype.totalCount, 60);
  assert.ok(first.retrieval.prototype.stratifiedCount > 0);
  assert.equal(first.retrieval.prototype.explorationCount, 1);
  assert.equal(first.ping.text.includes('old-rank-60'), true);
  assert.ok(first.nextCursor);
  assert.equal(decodeRecallCursor(first.nextCursor, { query: '全库', indexIdentity: 'full-ranking-index', beforeSeq: null }).offset, 48);

  const second = await host.beforeAnswer({ sessionId, query: '全库', cutoff: 2001, events: [], cursor: first.nextCursor });
  assert.equal(second.retrieval.prototype.offset, 48);
  assert.equal(second.retrieval.prototype.totalCount, 60);
  assert.equal(second.ping.text.includes('recent-rank-49'), true);
  assert.equal(second.ping.text.includes('old-rank-60'), false);
  assert.equal(second.nextCursor, null);
});

test('memory_recall forwards pagination arguments and returns full-library diagnostics', async () => {
  let seen;
  const tool = createMemoryRecallTool({
    beforeAnswer: async args => {
      seen = args;
      return {
        enabled: true,
        H: 1,
        ping: { text: '[记忆共振]\n- HIT example' },
        nextCursor: 'next-page',
        retrieval: { prototype: { candidateCount: 6, totalCount: 60, relevantCount: 5, explorationCount: 1 } },
      };
    },
    resolveSessionQuery: () => ({ readSession: async () => ({ events: [{ seq: 9 }], surface: { nodes: [9] } }) }),
  });
  const output = await tool.execute({ query: '旧目标', cursor: 'old-cursor', beforeSeq: 8 }, { agent: { session: { id: 's1' } } });
  assert.equal(seen.cursor, 'old-cursor');
  assert.equal(seen.beforeSeq, 8);
  assert.match(output, /全库检索：本页候选 6／全库 60，相关 5，时间探索 1/);
  assert.doesNotMatch(output, /shadow/);
  assert.match(output, /下一页 cursor：next-page/);
});

test('memory_recall exposes the next cursor on an empty page', async () => {
  const tool = createMemoryRecallTool({
    beforeAnswer: async () => ({
      enabled: true,
      H: 0,
      ping: { text: '' },
      nextCursor: 'page-after-empty',
      retrieval: { prototype: { candidateCount: 48, totalCount: 100, relevantCount: 0, explorationCount: 0 } },
    }),
    resolveSessionQuery: () => ({ readSession: async () => ({ events: [{ seq: 9 }], surface: { nodes: [9] } }) }),
  });
  const output = await tool.execute({ query: '空页' }, { agent: { session: { id: 's1' } } });
  assert.match(output, /本页没有可靠内容，可继续下一页/);
  assert.match(output, /下一页 cursor：page-after-empty/);
});

test('pagination stops when every remaining candidate is below tau', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-prototype-relevance-end-'));
  const sessionId = 'prototype-relevance-end';
  const scores = [
    ...Array.from({ length: 60 }, (_, index) => 0.99 - index * 0.005),
    ...Array.from({ length: 40 }, () => 0.2),
  ];
  activateFixture(home, sessionId, scores.map((score, index) => ({
    seq: index + 1,
    text: `ranked-${index + 1}`,
    vector: [score, Math.sqrt(1 - score * score)],
  })), 'relevance-end-index');
  const host = createTurnPingHost({
    home,
    config: { ...enabled, retrieval: { prototype: { enabled: true, noveltyThreshold: 1 } } },
    embedder: async () => [1, 0],
  });
  const first = await host.beforeAnswer({ sessionId, query: '边界', cutoff: 200, events: [] });
  assert.equal(first.retrieval.prototype.totalCount, 100);
  assert.equal(first.retrieval.prototype.hasMoreRelevant, true);
  assert.ok(first.nextCursor);

  const second = await host.beforeAnswer({ sessionId, query: '边界', cutoff: 201, events: [], cursor: first.nextCursor });
  assert.equal(second.H, 4);
  assert.equal(second.retrieval.prototype.offset, 48);
  assert.equal(second.retrieval.prototype.totalCount, 100);
  assert.equal(second.retrieval.prototype.hasMoreRelevant, false);
  assert.equal(second.nextCursor, null);
});
