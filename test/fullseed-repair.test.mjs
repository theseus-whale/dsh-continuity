import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRawChunks } from '../src/fullseed/chunks.mjs';
import { buildRepairPlan, runRepair, readRootCalls, reserveRootCall } from '../src/fullseed/repair.mjs';
import { stagingPaths } from '../src/fullseed/seed.mjs';

const SID = 'session-repair';
const vec = () => Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0));
const events = [
  { seq: 1, type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'one' }] } } },
  { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'two' }] } } },
  { seq: 3, type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'three' }] } } },
  { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'four' }] } } },
  { seq: 5, type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'five' }] } } },
  { seq: 6, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'six' }] } } },
];
function summary(chunk, prompt = 'old') {
  return { chunkId: chunk.chunkId, turnId: chunk.turnId, chunkIndex: chunk.chunkIndex, seqStart: chunk.seqStart, seqEnd: chunk.seqEnd, eventOffsets: chunk.eventOffsets, rawTextSha256: chunk.rawTextSha256, rawRecordSha256: chunk.rawRecordSha256, sourceViewSha256: chunk.rawTextSha256, firstFoldSeq: null, snapshotBoundary: null, availableCutoff: null, cutoffPolicy: 'activation-or-turn-end-v1', summaryText: `${prompt}-${chunk.chunkId}`, summarySha256: `${prompt}-sha-${chunk.chunkId}`, provider: 'fake', model: 'fake', promptVersion: prompt, promptTextSha256: 'p', extractionRuleSha256: 'e', status: 'complete', issues: [], attempts: [], usage: null, cohort: 'old' };
}
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-'));
  const chunks = buildRawChunks(SID, events, { checkpointSeq: Infinity }).chunks;
  const old = { chunks: chunks.slice(0, 2), missing: chunks[2] };
  const oldId = 'old-identity';
  const p = stagingPaths(root, oldId);
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.summaries, old.chunks.map((c) => JSON.stringify(summary(c, 'old'))).join('\n') + '\n');
  fs.writeFileSync(p.vectors, old.chunks.map((c) => JSON.stringify({ chunkId: c.chunkId, summarySha256: `old-sha-${c.chunkId}`, dimensions: 512, values: vec() })).join('\n') + '\n');
  const missing = path.join(root, 'missing.json');
  fs.writeFileSync(missing, JSON.stringify({ rows: [{ chunkId: old.missing.chunkId }] }));
  return { root, chunks, old, oldId, missing };
}
const provider = async ({ chunk }) => ({ chunkId: chunk.chunkId, L: '短句', concreteNouns: [] });

test('dryrun only reports missing and writes no root counter', async () => {
  const { root, oldId, missing } = setup();
  const plan = buildRepairPlan({ events, sessionId: SID, checkpointSeq: Infinity, missingPath: missing, oldIdentity: oldId, repairIdentity: 'repair-id', root, maxProviderCalls: 7802 });
  const result = await runRepair({ plan, dryRun: true, initialCalls: 4194, maxProviderCalls: 7802 });
  assert.equal(result.dryRun, true);
  assert.equal(result.acceptedOld, 2);
  assert.equal(result.missing, 1);
  assert.equal(fs.existsSync(path.join(root, 'provider-calls-root.json')), false);
});

test('root budget is cumulative and atomic', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-budget-'));
  assert.equal(reserveRootCall(root, { initialCalls: 4194, maxCalls: 7802 }), 4195);
  assert.equal(readRootCalls(root).calls, 4195);
  assert.throws(() => reserveRootCall(root, { maxCalls: 4195 }), /cap reached/);
});

test('missing plan rejects a chunk absent from raw', () => {
  const { root, oldId } = setup();
  const bad = path.join(root, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ rows: [{ chunkId: 'not-a-chunk' }] }));
  assert.throws(() => buildRepairPlan({ events, sessionId: SID, checkpointSeq: Infinity, missingPath: bad, oldIdentity: oldId, repairIdentity: 'r', root }), /absent/);
});

test('repair merge preserves old vector values and verifies 3 chunks', async () => {
  const { root, oldId, old, missing } = setup();
  const plan = buildRepairPlan({ events, sessionId: SID, checkpointSeq: Infinity, missingPath: missing, oldIdentity: oldId, repairIdentity: 'repair-id', root, maxProviderCalls: 7802 });
  const oldVectors = plan.oldVectors.map((v) => [...v]);
  const result = await runRepair({ plan, provider, embedder: async () => vec(), root, repairIdentity: 'repair-id', dryRun: false, initialCalls: 4194, maxProviderCalls: 7802, approve: true, expectedMissing: 1 });
  assert.equal(result.pending, 0);
  assert.equal(result.activated, true);
  assert.equal(result.repaired[0].summary.availableCutoff, 6);
  assert.deepEqual(result.base.manifest.vectors, 3);
  assert.deepEqual(plan.oldVectors, oldVectors);
  assert.equal(readRootCalls(root).calls, 4195);
});

test('repair failure leaves no active and old staging untouched', async () => {
  const { root, oldId, missing } = setup();
  const plan = buildRepairPlan({ events, sessionId: SID, checkpointSeq: Infinity, missingPath: missing, oldIdentity: oldId, repairIdentity: 'repair-id', root, maxProviderCalls: 7802 });
  const bad = async () => ({ chunkId: 'wrong', text: '' });
  const result = await runRepair({ plan, provider: bad, embedder: async () => vec(), root, repairIdentity: 'repair-id', dryRun: false, initialCalls: 4194, maxProviderCalls: 7802, approve: true, expectedMissing: 1 });
  assert.equal(result.pending, 1);
  assert.equal(result.activated, false);
  assert.equal(fs.existsSync(path.join(root, 'active.json')), false);
  assert.equal(fs.existsSync(stagingPaths(root, oldId).summaries), true);
});

test('only exact missing plan chunks are repaired', async () => {
  const { root, oldId, missing } = setup();
  const plan = buildRepairPlan({ events, sessionId: SID, checkpointSeq: Infinity, missingPath: missing, oldIdentity: oldId, repairIdentity: 'repair-id', root, maxProviderCalls: 7802 });
  assert.deepEqual(plan.missing.map((c) => c.chunkId), [plan.chunks[2].chunkId]);
  assert.equal(plan.oldAccepted.length, 2);
});
