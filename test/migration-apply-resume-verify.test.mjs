import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildRawChunks } from '../src/fullseed/chunks.mjs';
import { writeBase, writeDelta, activate } from '../src/fullseed/storage.mjs';
import { planMigration } from '../src/migration/plan.mjs';
import { readPlan, applyMigration } from '../src/migration/apply.mjs';
import { verifyMigration } from '../src/migration/verify.mjs';

const vec = (n = 0) => Array.from({ length: 512 }, (_, i) => (i === n ? 1 : 0));

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-apply-'));
  const dir = path.join(home, 'sessions', '--w--', 'session-test');
  fs.mkdirSync(dir, { recursive: true });
  const events = [
    { type: 'session', version: 4, id: 'session-test' },
    { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: 'alpha query' } },
    { seq: 2, type: 'assistant/message', data: { content: 'alpha answer' } },
  ];
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');
  return { home, dir };
}

test('offline apply activates only after all chunks, then verify query/raw-read', async () => {
  const { home } = makeHome();
  const planned = planMigration({ dshHome: home, sessionId: 'session-test' });
  const loaded = readPlan(planned.file);
  let calls = 0;
  const provider = async ({ chunkId }) => { calls += 1; return { chunkId, text: 'alpha summary' }; };
  const embedder = async () => vec();
  const result = await applyMigration({ planFile: planned.file, plan: loaded.plan, provider, embedder });
  assert.equal(calls, loaded.plan.missing);
  assert.equal(result.pending, 0);
  const active = JSON.parse(fs.readFileSync(path.join(loaded.plan.storageRoot, 'active.json'), 'utf8'));
  assert.equal(active.pending, 0);
  const verified = await verifyMigration({ plan: loaded.plan, query: 'alpha', embedder: async () => vec() });
  assert.equal(verified.ok, true);
  assert.equal(verified.chunks, loaded.plan.chunkSet.count);
  assert.ok(verified.query.hit);
  const activePath = path.join(loaded.plan.storageRoot, 'active.json');
  const activeBytes = fs.readFileSync(activePath, 'utf8');
  const activeObj = JSON.parse(activeBytes);
  fs.writeFileSync(activePath, JSON.stringify({ ...activeObj, identity: 'wrong-identity' }), 'utf8');
  const bad = await verifyMigration({ plan: loaded.plan, query: 'alpha', embedder: async () => vec() });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.includes('active identity'));
  fs.writeFileSync(activePath, activeBytes, 'utf8');
});

test('verify validates each base/delta artifact and merged coverage', async () => {
  const { home, dir } = makeHome();
  const events = fs.readFileSync(path.join(dir, 'session.v4.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  let chunks = buildRawChunks('session-test', events, { checkpointSeq: 5 }).chunks;
  if (chunks.length < 2) {
    events.push({ seq: 5, type: 'user/message', data: { source: { kind: 'user' }, content: 'second turn' } });
    events.push({ seq: 6, type: 'assistant/message', data: { content: 'second answer' } });
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');
    chunks = buildRawChunks('session-test', events, { checkpointSeq: 7 }).chunks;
  }
  const planned = planMigration({ dshHome: home, sessionId: 'session-test' });
  const loaded = readPlan(planned.file);
  const summaries = chunks.map((chunk, i) => ({ chunkId: chunk.chunkId, turnId: chunk.turnId, chunkIndex: i, seqStart: chunk.seqStart, seqEnd: chunk.seqEnd, rawTextSha256: chunk.rawTextSha256, eventOffsets: chunk.eventOffsets, summaryText: `summary ${i}`, summarySha256: createHash('sha256').update(`summary ${i}`).digest('hex'), availableCutoff: loaded.plan.checkpoint }));
  const vector = vec();
  const root = loaded.plan.storageRoot;
  writeBase(root, { baseId: 'base-one', summaries: [summaries[0]], vectors: [vector], identity: loaded.plan.identity, checkpoint: loaded.plan.checkpoint, snapshotBoundary: loaded.plan.checkpoint });
  writeDelta(root, { baseId: 'base-one', deltaId: 'delta-two', summaries: [summaries[1]], vectors: [vector], fromCheckpoint: loaded.plan.checkpoint, toCheckpoint: loaded.plan.checkpoint, identity: loaded.plan.identity, startOffset: 0 });
  activate(root, { baseId: 'base-one', deltaIds: ['delta-two'], identity: loaded.plan.identity, checkpoint: loaded.plan.checkpoint, snapshotBoundary: loaded.plan.checkpoint, pending: 0 });
  const verified = await verifyMigration({ plan: loaded.plan, query: 'summary', embedder: async () => vector });
  assert.equal(verified.ok, true);
  assert.deepEqual(verified.errors, []);
  const deltaManifest = path.join(root, 'bases', 'base-one', 'deltas', 'delta-two', 'manifest.json');
  const deltaBytes = fs.readFileSync(deltaManifest, 'utf8');
  const delta = JSON.parse(deltaBytes);
  fs.writeFileSync(deltaManifest, JSON.stringify({ ...delta, identity: 'wrong' }), 'utf8');
  const bad = await verifyMigration({ plan: loaded.plan, query: 'summary', embedder: async () => vector });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((error) => error.includes('delta identity')));
  fs.writeFileSync(deltaManifest, deltaBytes, 'utf8');
});

test('apply rejects changed raw/plan and failed run leaves old active absent/resumable', async () => {
  const { home } = makeHome();
  const planned = planMigration({ dshHome: home, sessionId: 'session-test' });
  const loaded = readPlan(planned.file);
  const rawPath = loaded.plan.raw.path;
  const original = fs.readFileSync(rawPath, 'utf8');
  fs.appendFileSync(rawPath, '\n');
  assert.rejects(() => applyMigration({ planFile: planned.file, plan: loaded.plan, provider: async () => ({ text: 'x' }), embedder: async () => vec() }), /raw hash changed/);
  fs.writeFileSync(rawPath, original, 'utf8');
  await assert.rejects(() => applyMigration({ planFile: planned.file, plan: loaded.plan, provider: async () => { throw new Error('crash'); }, embedder: async () => vec() }), /pending|crash/);
  assert.equal(fs.existsSync(path.join(loaded.plan.storageRoot, 'active.json')), false);
  const resumed = await applyMigration({ planFile: planned.file, plan: loaded.plan, provider: async ({ chunkId }) => ({ chunkId, text: 'alpha summary' }), embedder: async () => vec(), resume: true });
  assert.equal(resumed.pending, 0);
  assert.ok(fs.existsSync(path.join(loaded.plan.storageRoot, 'active.json')));
});

test('apply reuses only frozen fullseed items and does not re-call provider for them', async () => {
  const { home, dir } = makeHome();
  const events = fs.readFileSync(path.join(dir, 'session.v4.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  let chunks = buildRawChunks('session-test', events, { checkpointSeq: 5 }).chunks;
  if (chunks.length < 2) {
    events.push({ seq: 5, type: 'user/message', data: { source: { kind: 'user' }, content: 'second turn' } });
    events.push({ seq: 6, type: 'assistant/message', data: { content: 'second answer' } });
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');
    chunks = buildRawChunks('session-test', events, { checkpointSeq: 7 }).chunks;
  }
  const checkpoint = chunks.at(-1).checkpointSeq;
  const root = path.join(home, 'continuity', 'sessions', 'session-test', 'turn-ping', 'fullseed');
  const base = path.join(root, 'bases', 'base-reuse');
  fs.mkdirSync(base, { recursive: true });
  const chunk = chunks[0];
  const summaryText = 'frozen reusable summary';
  const summary = { chunkId: chunk.chunkId, turnId: chunk.turnId, chunkIndex: 0, seqStart: chunk.seqStart, seqEnd: chunk.seqEnd, rawTextSha256: chunk.rawTextSha256, summaryText, summarySha256: createHash('sha256').update(summaryText).digest('hex'), availableCutoff: 3, eventOffsets: chunk.eventOffsets };
  fs.writeFileSync(path.join(base, 'summaries.jsonl'), JSON.stringify(summary) + '\n', 'utf8');
  fs.writeFileSync(path.join(base, 'vector-records.jsonl'), JSON.stringify({ chunkId: chunk.chunkId, summarySha256: summary.summarySha256, dimensions: 512, offset: 0 }) + '\n', 'utf8');
  fs.writeFileSync(path.join(base, 'vectors.f32'), Buffer.alloc(512 * 4));
  fs.writeFileSync(path.join(root, 'active.json'), JSON.stringify({ version: 1, baseId: 'base-reuse', deltaIds: [], identity: 'old', checkpoint: 3, snapshotBoundary: 3, pending: 0 }), 'utf8');
  const planned = planMigration({ dshHome: home, sessionId: 'session-test' });
  const loaded = readPlan(planned.file);
  assert.equal(loaded.plan.reusable, 1);
  let calls = 0;
  const applied = await applyMigration({ planFile: planned.file, plan: loaded.plan, provider: async ({ chunkId }) => { calls += 1; return { chunkId, text: 'new summary' }; }, embedder: async () => vec() });
  assert.equal(calls, 1);
  assert.equal(applied.pending, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'active.json'), 'utf8')).pending, 0);
  const verified = await verifyMigration({ plan: loaded.plan, query: 'frozen reusable summary', embedder: async () => vec() });
  assert.equal(verified.ok, true);
});

test('CLI apply/resume wiring uses plan + approve + provider module', () => {
  const { home } = makeHome();
  const planned = planMigration({ dshHome: home, sessionId: 'session-test' });
  const moduleFile = path.join(home, 'mock-provider.mjs');
  fs.writeFileSync(moduleFile, `export async function createProvider() {
    return {
      provider: async ({ chunkId }) => ({ chunkId, text: 'alpha summary' }),
      embedder: async () => Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0)),
    };
  }
  export async function createEmbedder() {
    return async () => Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0));
  }\n`, 'utf8');
  const cli = path.resolve('bin/continuity-migrate.mjs');
  const applied = JSON.parse(execFileSync(process.execPath, [cli, 'migrate', 'apply', '--plan', planned.file, '--approve', '--provider-module', moduleFile], { encoding: 'utf8' }));
  assert.equal(applied.pending, 0);
  const verified = JSON.parse(execFileSync(process.execPath, [cli, 'migrate', 'verify', '--plan', planned.file, '--query', 'alpha', '--embedder-module', moduleFile], { encoding: 'utf8' }));
  assert.equal(verified.ok, true);
  assert.ok(fs.existsSync(path.join(home, 'continuity', 'sessions', 'session-test', 'turn-ping', 'fullseed', 'active.json')));
  const resumed = JSON.parse(execFileSync(process.execPath, [cli, 'migrate', 'resume', '--plan', planned.file, '--approve', '--provider-module', moduleFile], { encoding: 'utf8' }));
  assert.equal(resumed.pending, 0);
});

test('apply refuses plan content mutation', async () => {
  const { home } = makeHome();
  const planned = planMigration({ dshHome: home, sessionId: 'session-test' });
  const bad = JSON.parse(fs.readFileSync(planned.file, 'utf8'));
  bad.missing += 1;
  fs.writeFileSync(planned.file, JSON.stringify(bad, null, 2) + '\n', 'utf8');
  assert.throws(() => readPlan(planned.file), /content hash mismatch/);
});
