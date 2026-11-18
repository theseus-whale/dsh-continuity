import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChunkPing } from '../src/fullseed/ping.mjs';
import { buildPing } from '../src/turn-ping/ping.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTurnPingHost } from '../src/turn-ping/host.mjs';
import { createTurnPingStorage } from '../src/turn-ping/storage.mjs';
import { writeBase, activate } from '../src/fullseed/storage.mjs';
import { memoryCueMessage } from '../src/memory-cue.mjs';
import { isMemoryCueMessage } from '../src/memory-cue.mjs';
import { classifyLegacyCue } from '../src/legacy-cue-audit.mjs';

const forbidden = /run_code|tools\.|nextByteOffset|chunkId|read_raw_chunk|read_seq_range/;
const config = { retrieval: { maxSummariesPerFacet: 4, maxPingUtf8Bytes: 16384, maxSeqRefsPerFacet: 8 } };

test('fullseed ping has clue note and no mechanism trailer', () => {
  const summary = { chunkId: 'chunk-a', turnId: 'turn-1', seqStart: 1, seqEnd: 2, availableCutoff: 2, summaryText: '摘要正文' };
  const ping = buildChunkPing({ summaries: [summary], scored: [{ chunkId: 'chunk-a', score: 1 }], cutoff: 2, config });
  assert.match(ping.text, /^\[记忆共振\]/);
  assert.match(ping.text, /摘要是线索，不是原文/);
  assert.doesNotMatch(ping.text, forbidden);
});

test('turn-ping ping has clue note and no mechanism trailer', () => {
  const summary = { turnId: 'turn-1', seqStart: 1, seqEnd: 2, summaryText: '摘要正文' };
  const turn = { turnId: 'turn-1', seqStart: 1, seqEnd: 2 };
  const ping = buildPing({ summaryByTurn: new Map([['turn-1', summary]]), retrieval: { facets: [{ index: 0, H: 1, show: 1, high: [{ turnId: 'turn-1' }] }] }, turns: [turn], config });
  assert.match(ping.text, /^\[记忆共振｜/);
  assert.match(ping.text, /摘要是线索，不是原文/);
  assert.doesNotMatch(ping.text, forbidden);
});

const vec = () => Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0));
const embedder = async () => vec();
const hostConfig = { enabled: true, mode: 'opt-in', boundaries: { allowDefaultEnable: true } };
function summary(turnId, chunkId = turnId) { return { sessionId: 's', turnId, chunkId, seqStart: 1, seqEnd: 2, rawTextSha256: 'r', summaryText: 'alpha summary', summarySha256: 'sha-' + chunkId, availableCutoff: 2 }; }

async function legacyPing() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ping-native-'));
  const store = createTurnPingStorage({ home, sessionId: 's' });
  const s = summary('turn-1');
  await store.appendSummary(s);
  await store.appendVector({ turnId: s.turnId, summarySha256: s.summarySha256, availableCutoff: 2, dimensions: 512, vector: vec(), vectorIndexVersion: 'v' });
  const before = { summaries: (await store.summaries()).length, vectors: (await store.vectors()).length };
  const host = createTurnPingHost({ home, config: hostConfig, provider: async () => { throw new Error('unused'); }, embedder });
  const answer = await host.beforeAnswer({ sessionId: 's', query: 'alpha', cutoff: 2, turns: [{ turnId: 'turn-1', seqStart: 1, seqEnd: 2 }] });
  return { answer, store, before };
}

async function ptcPing() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ping-ptc-'));
  const fullseed = path.join(home, 'sessions', 's', 'turn-ping', 'fullseed');
  const s = summary('turn-1', 'chunk-1');
  writeBase(fullseed, { baseId: 'b', summaries: [s], vectors: [vec()], identity: 'i', checkpoint: 2, snapshotBoundary: null });
  activate(fullseed, { baseId: 'b', identity: 'i', checkpoint: 2, snapshotBoundary: null, pending: 0 });
  const before = fs.readFileSync(path.join(fullseed, 'active.json'), 'utf8');
  const store = createTurnPingStorage({ home, sessionId: 's' });
  const host = createTurnPingHost({ home, config: hostConfig, provider: async () => { throw new Error('unused'); }, embedder });
  const answer = await host.beforeAnswer({ sessionId: 's', query: 'alpha', cutoff: 2, events: [] });
  const after = fs.readFileSync(path.join(fullseed, 'active.json'), 'utf8');
  return { answer, store, before, after, activePath: path.join(fullseed, 'active.json') };
}

test('native and PTC actual ping assembly both fail closed on mechanism words', async () => {
  const native = await legacyPing();
  const ptc = await ptcPing();
  for (const { answer } of [native, ptc]) {
    assert.match(answer.ping.text, /摘要是线索，不是原文/);
    assert.doesNotMatch(answer.ping.text, /run_code|tools\.|nextByteOffset|chunkId|read_raw_chunk|read_seq_range/);
    const injected = memoryCueMessage(answer.ping.text);
    assert.equal(injected.source.kind, 'memory-cue');
    assert.match(injected.content[0].text, /摘要是线索，不是原文/);
    assert.doesNotMatch(injected.content[0].text, /run_code|tools\.|nextByteOffset|chunkId|read_raw_chunk|read_seq_range/);
    assert.ok(answer.H >= 1);
  }
  assert.deepEqual({ summaries: (await native.store.summaries()).length, vectors: (await native.store.vectors()).length }, native.before);
  assert.equal(ptc.before, ptc.after);
});

const injectedText = (m) => Array.isArray(m.content) ? m.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : String(m.content ?? '');
const scanInjectedSince = (messages, cursor) => messages.slice(cursor)
  .filter((m) => isMemoryCueMessage(m) || classifyLegacyCue(m) === 'active-legacy')
  .flatMap((m) => injectedText(m).match(/run_code|tools\.|nextByteOffset|chunkId|read_raw_chunk|read_seq_range/g) ?? []);

test('repair cursor scans only new memory-cue and legacy turn-ping-memory injections; history and ordinary messages are immutable', () => {
  const historicalViolation = { source: { kind: 'turn-ping-memory' }, content: [{ type: 'text', text: 'run_code' }] };
  const ordinaryDiscussion = { source: { kind: 'user' }, content: [{ type: 'text', text: 'run_code tools. nextByteOffset chunkId' }] };
  const runtimeContext = { source: { kind: 'user' }, content: [{ type: 'text', text: 'Current runtime context' }] };
  const cleanPing = memoryCueMessage('摘要是线索，不是原文。');
  const messages = [historicalViolation, ordinaryDiscussion, runtimeContext, cleanPing];
  assert.deepEqual(scanInjectedSince(messages, 1), []);
  assert.equal(scanInjectedSince(messages, 0).length, 1);
});
