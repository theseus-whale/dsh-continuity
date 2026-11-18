import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, name as pluginName, inject as pluginInject } from '../src/fullseed/read-raw-chunk-plugin.mjs';
import { writeBase, activate } from '../src/fullseed/storage.mjs';
import { turnPingRoot } from '../src/turn-ping/storage.mjs';

const SID = 'session-read-raw';
const vec = () => Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0));
const identity = 'id';
function summary() {
  return {
    sessionId: SID, turnId: 'turn-000002', chunkId: 'chunk-a', chunkIndex: 0,
    seqStart: 2, seqEnd: 3, eventOffsets: [{ seq: 2, start: 0, end: 2 }, { seq: 3, start: 0, end: 2 }],
    rawTextSha256: 'r', rawRecordSha256: 'rr', sourceViewSha256: 's', firstFoldSeq: null,
    snapshotBoundary: 3, availableCutoff: 3, cutoffPolicy: 'activation-or-turn-end-v1',
    summaryText: 'x', summarySha256: 'sx', provider: 'm', model: 'm', promptVersion: 'v2',
    promptTextSha256: 'p', extractionRuleSha256: 'e', status: 'complete', issues: [], attempts: [], usage: null,
  };
}

function ctxWith(toolRef) {
  return {
    get: () => null,
    // Match the working read_seq_range preset path: the tools service is
    // already injected, so registration must not depend on another inject().
    effect: (fn) => fn(),
    tools: { register: (tool) => { toolRef.tool = tool; return () => {}; } },
  };
}

test('plugin registers read_raw_chunk and reads canonical raw with continuation', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fullseed-rrc-'));
  const root = path.join(turnPingRoot({ home, sessionId: SID }), 'fullseed');
  writeBase(root, { baseId: 'b1', summaries: [summary()], vectors: [vec()], identity, checkpoint: 3, snapshotBoundary: 3 });
  activate(root, { baseId: 'b1', identity, checkpoint: 3, snapshotBoundary: 3, pending: 0 });
  const ref = {};
  assert.equal(pluginName, 'read-raw-chunk-tool');
  assert.deepEqual(pluginInject, ['tools']);
  apply(ctxWith(ref), { home });
  assert.equal(ref.tool.name, 'read_raw_chunk');
  let seenSessionArg = null;
  const sessionQuery = { async readSession(sessionId) { seenSessionArg = sessionId; return { events: [
    { seq: 2, type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } } },
    { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '世界' }] } } },
  ] }; } };
  const exec = { agent: { session: { id: SID }, ctx: { get: (key) => key === 'sessionQuery' ? sessionQuery : undefined } } };
  const first = JSON.parse(await ref.tool.execute({ chunkId: 'chunk-a', maxBytes: 8 }, exec));
  assert.equal(seenSessionArg, SID);
  assert.equal(first.nextByteOffset, 8);
  const second = JSON.parse(await ref.tool.execute({ chunkId: 'chunk-a', byteOffset: first.nextByteOffset }, exec));
  assert.equal(first.text + second.text, '你好\n\n世界');
  await assert.rejects(() => ref.tool.execute({ chunkId: 'missing' }, exec), /unknown chunkId/);
  await assert.rejects(() => ref.tool.execute({ chunkId: 'chunk-a', byteOffset: 1 }, exec), /character boundary/);
});

test('both preset entries and package export exist', () => {
  const yml = fs.readFileSync(path.join(process.cwd(), 'cordis.patch.yml'), 'utf8');
  assert.equal((yml.match(/- id: read-raw-chunk-tool/g) ?? []).length, 2);
  assert.equal((yml.match(/name: ['"]?@theseus-whale\/dsh-continuity\/read-raw-chunk-tool/g) ?? []).length, 2);
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  assert.equal(pkg.exports['./read-raw-chunk-tool'], './src/fullseed/read-raw-chunk-plugin.mjs');
});

test('default root uses continuityHome when no config.home/ctx.home', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fullseed-defhome-'));
  const old = process.env.DSH_CONTINUITY_HOME;
  process.env.DSH_CONTINUITY_HOME = home;
  try {
    const root = path.join(turnPingRoot({ home, sessionId: SID }), 'fullseed');
    writeBase(root, { baseId: 'b1', summaries: [summary()], vectors: [vec()], identity, checkpoint: 3, snapshotBoundary: 3 });
    activate(root, { baseId: 'b1', identity, checkpoint: 3, snapshotBoundary: 3, pending: 0 });
    const ref = {};
    apply(ctxWith(ref));
    const sessionQuery = { async readSession() { return { events: [
      { seq: 2, type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } } },
      { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '世界' }] } } },
    ] }; } };
    const exec = { agent: { session: { id: SID }, ctx: { get: (key) => key === 'sessionQuery' ? sessionQuery : undefined } } };
    const out = JSON.parse(await ref.tool.execute({ chunkId: 'chunk-a' }, exec));
    assert.equal(out.text, '你好\n\n世界');
  } finally {
    if (old === undefined) delete process.env.DSH_CONTINUITY_HOME; else process.env.DSH_CONTINUITY_HOME = old;
  }
});

test('plugin never touches ctx.home (illegal without inject)', () => {
  const ctx = { get: () => undefined, effect: (fn) => fn(), tools: { register: () => () => {} } };
  Object.defineProperty(ctx, 'home', { get() { throw new Error('cannot get property home without inject'); } });
  assert.doesNotThrow(() => apply(ctx));
});

test('unified summary without eventOffsets reads and verifies the complete raw turn', async () => {
  const { createHash } = await import('node:crypto');
  const hash = (text) => createHash('sha256').update(text).digest('hex');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fullseed-unified-read-'));
  const root = path.join(turnPingRoot({ home, sessionId: SID }), 'fullseed');
  const unified = { ...summary(), chunkId: 'chunk-unified', rawTextSha256: hash('你好\n世界') };
  delete unified.eventOffsets;
  writeBase(root, { baseId: 'b1', summaries: [unified], vectors: [vec()], identity, checkpoint: 3, snapshotBoundary: 3 });
  activate(root, { baseId: 'b1', identity, checkpoint: 3, snapshotBoundary: 3, pending: 0 });
  const ref = {};
  apply(ctxWith(ref), { home });
  const events = [
    { seq: 2, type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } } },
    { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '世界' }] } } },
  ];
  const sessionQuery = { readSession: async () => ({ events }) };
  const exec = { agent: { session: { id: SID }, ctx: { get: (key) => key === 'sessionQuery' ? sessionQuery : undefined } } };
  const out = JSON.parse(await ref.tool.execute({ chunkId: 'chunk-unified' }, exec));
  assert.equal(out.text, '你好\n\n世界');
  const badQuery = { readSession: async () => ({ events: events.with(1, { ...events[1], data: { message: { content: [{ type: 'text', text: '改动' }] } } }) }) };
  const badExec = { agent: { session: { id: SID }, ctx: { get: (key) => key === 'sessionQuery' ? badQuery : undefined } } };
  await assert.rejects(() => ref.tool.execute({ chunkId: 'chunk-unified' }, badExec), /raw turn hash mismatch/);
});
