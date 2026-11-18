import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRawIndex, RAW_INDEX_VERSION } from '../src/turn-ping/raw-index.mjs';
import { installRawIndexHost } from '../src/turn-ping/raw-index-host.mjs';
import { createTurnPingHost } from '../src/turn-ping/host.mjs';

function home() { return fs.mkdtempSync(path.join(os.tmpdir(), 'raw-index-')); }
function event(seq, text, type = 'user/message', sourceKind = 'user') {
  return { seq, type, data: { message: { content: [{ type: 'text', text }], source: { kind: sourceKind } } } };
}
function readJsonl(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
}

test('raw event is searchable immediately, with full text, stable hash and no fold', () => {
  const root = home();
  const index = createRawIndex({ home: root, sessionId: 'session-a' });
  const suffix = '唯一尾句ZZ-742';
  const text = `${'前部内容'.repeat(80)}${suffix}`;
  const result = index.ingest(event(10, text));
  assert.equal(result.indexed, true);
  assert.equal(result.rawTextSha256.length, 64);
  const hits = index.search('ZZ-742');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].seq, 10);
  assert.equal(hits[0].indexVersion, RAW_INDEX_VERSION);
  assert.equal(hits[0].bytes, Buffer.byteLength(text));
  assert.equal(index.search('记忆宫殿', { beforeSeq: 10 }).length, 0);
});

test('duplicate delivery is idempotent and cue/runtime events never enter the index', () => {
  const root = home();
  const index = createRawIndex({ home: root, sessionId: 'session-a' });
  index.ingest(event(1, '真正的用户原话'));
  index.ingest(event(1, '真正的用户原话'));
  index.ingest(event(2, '[记忆共振] 旧提示', 'user/message', 'memory-cue'));
  index.ingest(event(3, '时间上下文', 'user/message', 'time-context'));
  index.ingest(event(4, 'not a conversation event', 'turn/end'));
  assert.equal(index.status().records, 1);
  assert.equal(readJsonl(index.file).length, 1);
});

test('corrupt derived JSONL is rebuilt atomically from canonical events', () => {
  const root = home();
  const events = [event(1, '第一段原文'), event(2, '第二段原文'), event(3, '第三段原文')];
  const first = createRawIndex({ home: root, sessionId: 'session-a' });
  first.reconcile(events.slice(0, 2));
  fs.appendFileSync(first.file, '{broken-partial', 'utf8');
  const second = createRawIndex({ home: root, sessionId: 'session-a' });
  const result = second.reconcile(events);
  assert.equal(result.rebuilt, true);
  assert.deepEqual(result.missingSeqs, []);
  assert.equal(second.status().records, 3);
  assert.equal(second.search('第三段').length, 1);
  const diagnostics = readJsonl(path.join(root, 'turn-ping-prestep-debug.jsonl'));
  assert.equal(diagnostics.some((row) => row.kind === 'raw-index-rebuilt' && row.sessionId === 'session-a'), true);
});

test('same seq with changed canonical content fails closed and is diagnosed', () => {
  const root = home();
  const index = createRawIndex({ home: root, sessionId: 'session-a' });
  index.ingest(event(8, '原始版本'));
  assert.throws(() => index.ingest(event(8, '不同版本')), /canonical event changed/);
  const diagnostics = readJsonl(path.join(root, 'turn-ping-prestep-debug.jsonl'));
  assert.equal(diagnostics.some((row) => row.kind === 'raw-index-conflict' && row.seq === 8), true);
  assert.equal(index.search('原始版本').length, 1);
  assert.equal(index.search('不同版本').length, 0);
});

test('host reconciles an existing session, indexes later events, and isolates outsiders', () => {
  const root = home();
  const listeners = new Map();
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); } };
  const indexFor = (sessionId) => createRawIndex({ home: root, sessionId });
  const installed = installRawIndexHost({
    ctx, home: root, indexFor,
    config: { enabled: true, sessionIds: ['session-a'] },
  });
  const a = { id: 'session-a', snapshotEvents: () => [event(1, '启动前已有原文')] };
  const b = { id: 'session-b', snapshotEvents: () => [event(1, '别的会话')] };
  installed.open(a);
  installed.open(b);
  listeners.get('session/event')(a, event(2, '启动后新增原文'));
  assert.equal(installed.open(a).reconciled, false);
  assert.equal(indexFor('session-a').status().records, 2);
  assert.equal(fs.existsSync(path.join(root, 'sessions', 'session-b')), false);
  assert.equal(installed.errors.length, 0);
});

test('beforeAnswer can use raw evidence without summaries, vectors, provider or embedding calls', async () => {
  const root = home();
  let calls = 0;
  const forbidden = async () => { calls += 1; throw new Error('must not be called'); };
  const host = createTurnPingHost({
    home: root,
    config: { enabled: true, sessionIds: ['session-a'], boundaries: { allowDefaultEnable: true } },
    provider: forbidden,
    embedder: forbidden,
  });
  host.rawIndexFor('session-a').ingest(event(20, '我在旧轮次讨论过记忆共振的设计'));
  const result = await host.beforeAnswer({ sessionId: 'session-a', query: '记忆共振', cutoff: 21, events: [] });
  assert.equal(result.H, 1);
  assert.equal(result.indexVersion, RAW_INDEX_VERSION);
  assert.equal(result.retrieval.raw, true);
  assert.match(result.ping.text, /\[记忆共振\]/);
  assert.match(result.ping.text, /seq=20/);
  assert.equal(calls, 0);
});
