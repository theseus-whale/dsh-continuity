import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTurnPingHost } from '../src/turn-ping/host.mjs';
import { installTurnPingPreStep } from '../src/turn-ping/pre-step.mjs';
import { writeBase, activate } from '../src/fullseed/storage.mjs';
import { clearActiveCache } from '../src/fullseed/cache.mjs';
import {
  extractVisibleMemoryIds, hasMemoryIntent, markCueHistory, readQuietConfig, recentCueIds, selectNovelHits,
} from '../src/turn-ping/quiet.mjs';

const hit = (id, vector, score = 1) => ({ summary: { chunkId: id, turnId: id }, vector, score });

test('quiet intent, visible pointers and vector novelty select distinct memories without a fixed cap', () => {
  assert.equal(hasMemoryIntent('现在吵不吵'), false);
  assert.equal(hasMemoryIntent('我们不是说过记忆降噪吗'), true);
  const ids = extractVisibleMemoryIds(`HIT ${'a'.repeat(64)} turn-000010 turn_abcdef`);
  assert.deepEqual([...ids], ['turn-000010', 'turn_abcdef', 'a'.repeat(64)]);
  const hits = [hit('a', [1, 0]), hit('b', [0.99, 0.01]), hit('c', [0, 1]), hit('d', [-1, 0])];
  assert.deepEqual(selectNovelHits(hits, []).map(row => row.summary.chunkId), ['a', 'c', 'd']);
  assert.deepEqual(selectNovelHits(hits, [[1, 0]]).map(row => row.summary.chunkId), ['c', 'd']);
});

test('cue history expires and config supports quiet/off/legacy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-quiet-history-'));
  const now = Date.now();
  markCueHistory(root, ['a'], now);
  assert.equal(recentCueIds(root, now + 1000).has('a'), true);
  assert.equal(recentCueIds(root, now + 31 * 60_000).has('a'), false);
  assert.equal(readQuietConfig({}).mode, 'quiet');
  assert.equal(readQuietConfig({ autoRecall: { mode: 'off' } }).mode, 'off');
  assert.equal(readQuietConfig({ autoRecall: { mode: 'legacy' } }).mode, 'legacy');
});

test('fullseed quiet recall applies novelty and recent-history dedup; manual recall stays unchanged', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-quiet-host-'));
  const sessionId = 'quiet-session';
  const root = path.join(home, 'sessions', sessionId, 'turn-ping', 'fullseed');
  const summaries = ['a', 'b', 'c'].map((id, index) => ({
    sessionId, turnId: `turn-${id}`, chunkId: id.repeat(64), chunkIndex: 0,
    seqStart: index + 1, seqEnd: index + 1, rawTextSha256: id, rawRecordSha256: id,
    sourceViewSha256: id, availableCutoff: 10, snapshotBoundary: 10, summaryText: `摘要 ${id}`,
  }));
  writeBase(root, { baseId: 'base-quiet', summaries, vectors: [[1, 0], [0.99, 0.01], [0, 1]], identity: 'quiet', checkpoint: 10, snapshotBoundary: 10 });
  activate(root, { baseId: 'base-quiet', identity: 'quiet', checkpoint: 10, snapshotBoundary: 10, pending: 0 });
  clearActiveCache();
  const host = createTurnPingHost({
    home,
    config: { enabled: true, boundaries: { allowDefaultEnable: true }, rawIndex: { enabled: false } },
    embedder: async () => [1, 1],
  });
  const first = await host.beforeAnswer({ sessionId, query: '上次讨论什么', cutoff: 10, events: [], quiet: true, visibleMemoryIds: new Set() });
  assert.equal(first.H, 2);
  assert.equal(first.shownIds.includes('a'.repeat(64)) || first.shownIds.includes('b'.repeat(64)), true, JSON.stringify(first));
  assert.equal(first.shownIds.includes('a'.repeat(64)) && first.shownIds.includes('b'.repeat(64)), false);
  assert.equal(first.shownIds.includes('c'.repeat(64)), true);
  const repeat = await host.beforeAnswer({ sessionId, query: '上次讨论什么', cutoff: 10, events: [], quiet: true, visibleMemoryIds: new Set() });
  assert.equal(repeat.H, 0);
  assert.equal(repeat.ping.text, '');
  const manual = await host.beforeAnswer({ sessionId, query: '现在吵不吵', cutoff: 10, events: [] });
  assert.equal(manual.H, 3);
});

test('pre-step gates ordinary input and off, while legacy and explicit recall intent still retrieve', async () => {
  async function run(text, mode = 'quiet', existingCue = false) {
    let calls = 0;
    let seen = null;
    const listeners = new Map();
    const ctx = { on: (name, fn) => listeners.set(name, fn) };
    const session = {
      id: 's1', surface: { nodes: [1] },
      eventAt: seq => existingCue ? { seq, type: 'user/message', data: { message: { role: 'user', source: { kind: 'memory-cue' }, content: [{ type: 'text', text: 'HIT turn-000001' }] } } } : null,
      snapshotEvents: () => [],
    };
    installTurnPingPreStep({
      ctx,
      config: { mode: 'opt-in', boundaries: { allowLiveInjection: true }, autoRecall: { mode } },
      beforeAnswer: async args => { calls++; seen = args; return { enabled: true, H: 1, ping: { text: '[记忆共振] HIT' } }; },
      log: console,
    });
    const listener = listeners.get('agent/pre-step');
    await listener({ agent: { session }, step: 1 }, async () => ({ messages: [{ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }] }));
    return { calls, seen };
  }
  assert.equal((await run('现在吵不吵')).calls, 0);
  assert.equal((await run('现在吵不吵', 'off')).calls, 0);
  const legacy = await run('现在吵不吵', 'legacy');
  assert.equal(legacy.calls, 1);
  assert.equal(legacy.seen.quiet, false);
  const recalled = await run('上次我们说过什么', 'quiet', true);
  assert.equal(recalled.calls, 1);
  assert.equal(recalled.seen.quiet, true);
  assert.equal(recalled.seen.visibleMemoryIds.has('turn-000001'), true);
});
