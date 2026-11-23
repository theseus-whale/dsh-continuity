import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTurnPingHost, buildTurnsFromEvents } from '../src/turn-ping/host.mjs';
import { createReadSeqRangeTool } from '../src/turn-ping/read-tool.mjs';
import { readConfig } from '../src/turn-ping/config.mjs';

const events = [
  { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: '旧主题 A' } },
  { seq: 2, type: 'assistant/message', data: { content: '确认 A 的决定' } },
  { seq: 3, type: 'user/message', data: { source: { kind: 'user' }, content: '继续 A' } },
];
const turns = [{ turnId: 'turn-000001', seqStart: 1, seqEnd: 2, boundarySeqs: [1, 2], rawTextSha256: 'raw1' }];

test('default-off host performs no writes or retrieval', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-ping-v5-'));
  const host = createTurnPingHost({ config: {}, home, provider: async () => { throw new Error('must not call'); }, embedder: async () => [1, 0] });
  const fold = await host.onFold({ sessionId: 's1', fold: { from: 1, to: 3, cutoff: 2, shadowedSeqs: [1, 2] }, events, turns });
  assert.equal(fold.enabled, false);
  assert.equal(fold.writes, 0);
  const answer = await host.beforeAnswer({ sessionId: 's1', query: 'A', cutoff: 2, turns });
  assert.equal(answer.enabled, false);
  assert.equal(answer.ping, null);
});

test('enabled fold writes independent summary and vector, retrieval resolves same chain', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-ping-v5-'));
  const config = { enabled: true, boundaries: { allowDefaultEnable: true }, vector: { dimensions: 2 } };
  let calls = 0;
  const provider = async () => { calls += 1; return { text: '本轮确认了 A 的决定与旧主题。', model: 'mock', usage: { total_tokens: 3 } }; };
  const embedder = async (text) => (String(text).includes('A') ? [1, 0] : [0, 1]);
  const host = createTurnPingHost({ config, home, provider, embedder });
  const fold = await host.onFold({ sessionId: 's1', fold: { compactionId: 'f1', from: 1, to: 3, cutoff: 2, shadowedSeqs: [1, 2] }, events, turns });
  assert.equal(fold.enabled, true);
  assert.equal(fold.writes, 1);
  assert.equal(calls, 1);
  const storage = host.storageFor('s1');
  assert.equal((await storage.summaries()).length, 1);
  assert.equal((await storage.vectors()).length, 1);
  assert.ok(fs.existsSync(storage.summaryFile));
  assert.ok(fs.existsSync(storage.vectorFile));
  const answer = await host.beforeAnswer({ sessionId: 's1', query: 'A', cutoff: 2, turns });
  assert.equal(answer.enabled, true);
  assert.ok(answer.ping.text.includes('turn-000001'));
  assert.ok(answer.ping.text.includes('Local seq only'));
  assert.ok(answer.ping.text.includes('摘要仅作定位：按 seq 回读；追溯用原文措辞＋beforeSeq 查更早。无命中≠不存在。'));
  assert.doesNotMatch(answer.ping.text, /run_code|tools\.|nextByteOffset|chunkId|read_raw_chunk|read_seq_range/);
  const retry = await host.onFold({ sessionId: 's1', fold: { compactionId: 'f1', from: 1, to: 3, cutoff: 2, shadowedSeqs: [1, 2] }, events, turns });
  assert.equal(retry.writes, 0);
  assert.equal(calls, 1);
});

test('fields are persisted; no concreteNouns/keywords fields', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-ping-v5-'));
  const host = createTurnPingHost({
    config: { enabled: true, boundaries: { allowDefaultEnable: true }, vector: { dimensions: 2 } },
    home,
    provider: async () => ({ text: '一句摘要。', model: 'm', usage: { total_tokens: 1 } }),
    embedder: async () => [1, 0],
  });
  await host.onFold({ sessionId: 's1', fold: { from: 1, to: 3, cutoff: 2, shadowedSeqs: [1, 2] }, events, turns });
  const row = (await host.storageFor('s1').summaries())[0];
  assert.ok(row.rawTextSha256);
  assert.ok(row.sourceViewSha256);
  assert.equal(typeof row.summaryLength, 'number');
  assert.ok('usage' in row);
  assert.equal('concreteNouns' in row, false);
  assert.equal('keywords' in row, false);
});

test('enabled host with no hit does not add the read hint', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-ping-v5-'));
  const host = createTurnPingHost({ config: { enabled: true, boundaries: { allowDefaultEnable: true } }, home, provider: async () => ({ text: 'x', model: 'm', usage: null }), embedder: async () => [1, 0] });
  const answer = await host.beforeAnswer({ sessionId: 'empty', query: 'nothing', cutoff: 1, turns });
  assert.equal(answer.enabled, true);
  assert.equal(answer.ping.text, '');
  assert.equal(answer.ping.text.includes('read_seq_range'), false);
});

test('read_seq_range returns bounded raw text and dual hashes', async () => {
  const sessionQuery = {
    async readSession() {
      return { events: [
        { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: 'x'.repeat(5000) } },
        { seq: 2, type: 'assistant/message', data: { content: 'tail' } },
      ] };
    },
  };
  const tool = createReadSeqRangeTool({ sessionQuery });
  const output = JSON.parse(await tool.execute({ fromSeq: 1, toSeq: 2 }, { agent: { session: { id: 's1' } } }));
  assert.equal(output.truncated, true);
  assert.ok(output.returnedBytes <= 4096);
  assert.match(output.rawTextSha256, /^[a-f0-9]{64}$/);
  assert.match(output.rawRecordSha256, /^[a-f0-9]{64}$/);
});
