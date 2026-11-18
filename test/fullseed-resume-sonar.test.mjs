import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRawChunks } from '../src/fullseed/chunks.mjs';
import { runSeed, buildIdentity } from '../src/fullseed/seed.mjs';
import { readSonarSeed, querySonarSeed } from '../src/fullseed/sonar-adapter.mjs';
import { createTurnPingHost } from '../src/turn-ping/host.mjs';
import { turnPingRoot } from '../src/turn-ping/storage.mjs';

const SID = 'session-resume';
const vec = () => Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0));
const identity = buildIdentity({ promptTextSha256: 'p', extractionRuleSha256: 'e' });
const events = [
  { seq: 1, type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'one' }] } } },
  { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'two' }] } } },
  { seq: 3, type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'three' }] } } },
  { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'four' }] } } },
];

test('restart staging resume does not repeat accepted provider work', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fullseed-resume-'));
  const chunks = buildRawChunks(SID, events, { checkpointSeq: Infinity }).chunks;
  let calls = 0;
  const first = await runSeed({ chunks: [chunks[0]], root, provider: async () => { calls += 1; return { text: '一句摘要' }; }, embedder: async () => vec(), identity, checkpoint: 2, snapshotBoundary: 2 });
  assert.equal(first.pending, 0);
  assert.equal(calls, 1);
  const callsBefore = calls;
  const second = await runSeed({ chunks: [chunks[0]], root, provider: async () => { calls += 1; return { text: '一句摘要' }; }, embedder: async () => vec(), identity, checkpoint: 2, snapshotBoundary: 2 });
  assert.equal(calls, callsBefore);
  assert.equal(second.pending, 0);
});

test('failed run leaves prior active untouched', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fullseed-active-'));
  const root = path.join(turnPingRoot({ home, sessionId: SID }), 'fullseed');
  const chunks = buildRawChunks(SID, events, { checkpointSeq: Infinity }).chunks;
  await runSeed({ chunks: [chunks[0]], root, provider: async () => ({ text: '一句摘要' }), embedder: async () => vec(), identity, checkpoint: 2, snapshotBoundary: 2 });
  const before = fs.readFileSync(path.join(root, 'active.json'), 'utf8');
  await runSeed({ chunks: [chunks[1]], root, provider: async () => { throw new Error('down'); }, embedder: async () => vec(), identity, checkpoint: 4, snapshotBoundary: 4 });
  assert.equal(fs.readFileSync(path.join(root, 'active.json'), 'utf8'), before);
});

test('Sonar legacy activation is read-only and visible', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fullseed-sonar-'));
  fs.mkdirSync(path.join(root, 'activations', 'v1'), { recursive: true });
  fs.writeFileSync(path.join(root, 'activations', 'active.json'), JSON.stringify({ versionId: 'v1' }));
  fs.writeFileSync(path.join(root, 'activations', 'v1', 'summaries.jsonl'), JSON.stringify({ turnId: 'old' }) + '\n');
  fs.writeFileSync(path.join(root, 'activations', 'v1', 'vectors.jsonl'), JSON.stringify({ turnId: 'old', vector: [1] }) + '\n');
  const before = fs.readFileSync(path.join(root, 'activations', 'active.json'), 'utf8');
  const seed = readSonarSeed(root);
  assert.equal(seed.present, true);
  assert.equal(seed.readOnly, true);
  assert.equal(seed.versionId, 'v1');
  assert.equal(seed.counts.summaries, 1);
  assert.equal(fs.readFileSync(path.join(root, 'activations', 'active.json'), 'utf8'), before);
});

test('real Sonar active is queryable read-only with unchanged pointer hash', () => {
  const root = process.env.DSH_CONTINUITY_TEST_SONAR_ROOT;
  if (!root || !fs.existsSync(root)) return;
  const pointer = path.join(root, 'activations', 'active.json');
  if (!fs.existsSync(pointer)) return;
  const before = fs.readFileSync(pointer, 'utf8');
  const seed = readSonarSeed(root);
  assert.equal(seed.present, true);
  const vector = Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0));
  const result = querySonarSeed(root, vector, { cutoff: Infinity, limit: 4 });
  assert.equal(result.readOnly, true);
  assert.ok(result.hits.length > 0);
  assert.equal(fs.readFileSync(pointer, 'utf8'), before);
  assert.equal(seed.counts.summaries, result.hits.length >= 4 ? 4 : seed.counts.summaries);
});

test('real Sonar active works through production beforeAnswer path', async () => {
  const home = process.env.DSH_CONTINUITY_TEST_HOME;
  const sid = process.env.DSH_CONTINUITY_TEST_SONAR_SESSION;
  if (!home || !sid) return;
  const root = path.join(home, 'sessions', sid, 'turn-ping');
  if (!fs.existsSync(path.join(root, 'activations', 'active.json'))) return;
  const seed = readSonarSeed(root);
  const vector = seed.vectors[0].vector;
  const host = createTurnPingHost({ home, config: { enabled: true, boundaries: { allowDefaultEnable: true } }, embedder: async () => vector });
  const turns = seed.summaries.map((s) => ({ turnId: s.turnId, seqStart: s.seqStart, seqEnd: s.seqEnd }));
  const result = await host.beforeAnswer({ sessionId: sid, query: 'q', cutoff: 2134, turns });
  assert.equal(result.enabled, true);
  assert.ok(result.H > 0);
  assert.ok(result.ping.text.length > 0);
});

test('partial staging writes no base and identity change does not reuse summaries', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fullseed-partial-'));
  const chunks = buildRawChunks(SID, events, { checkpointSeq: Infinity }).chunks;
  let calls = 0;
  const partial = await runSeed({ chunks: [chunks[0], chunks[1]], root, provider: async () => { calls += 1; if (calls > 1) throw new Error('stop'); return { text: '一句摘要' }; }, embedder: async () => vec(), identity, checkpoint: 4, snapshotBoundary: 4, concurrency: 1 });
  assert.equal(partial.pending, 1);
  assert.equal(partial.base, null);
  assert.equal(fs.existsSync(path.join(root, 'bases')), false);
  const other = buildIdentity({ promptTextSha256: 'different', extractionRuleSha256: 'e' });
  const before = calls;
  await runSeed({ chunks: [chunks[0]], root, provider: async () => { calls += 1; return { text: '一句摘要' }; }, embedder: async () => vec(), identity: other, checkpoint: 2, snapshotBoundary: 2 });
  assert.equal(calls > before, true);
});

test('maxProviderCalls hard cap stops retries and leaves pending', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fullseed-cap-'));
  const chunks = buildRawChunks(SID, events, { checkpointSeq: Infinity }).chunks;
  let calls = 0;
  const result = await runSeed({ chunks: [chunks[0]], root, provider: async () => { calls += 1; return { text: '' }; }, embedder: async () => vec(), identity, checkpoint: 2, snapshotBoundary: 2, maxAttempts: 2, maxProviderCalls: 1 });
  assert.equal(calls, 1);
  assert.equal(result.pending, 1);
});

test('provider call cap is cumulative across resumed processes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fullseed-cap-resume-'));
  const chunks = buildRawChunks(SID, events, { checkpointSeq: Infinity }).chunks;
  let calls = 0;
  const options = {
    chunks, root, embedder: async () => vec(), identity, checkpoint: 4,
    snapshotBoundary: 4, concurrency: 1, maxAttempts: 1, maxProviderCalls: 1,
    provider: async () => { calls += 1; throw new Error('provider unavailable'); },
  };
  const first = await runSeed(options);
  assert.equal(first.pending, 2);
  assert.equal(calls, 1);
  const resumed = await runSeed(options);
  assert.equal(resumed.pending, 2);
  assert.equal(calls, 1);
});
