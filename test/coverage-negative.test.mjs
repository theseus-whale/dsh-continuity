import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planCoverage } from '../src/turn-ping/coverage/planner.mjs';
import { createCoverageStaging } from '../src/turn-ping/coverage/staging.mjs';
import { runCoveragePlan } from '../src/turn-ping/coverage/runner.mjs';
import { ensureCoverage, resumeCoverageJobs, onFoldCoverage } from '../src/turn-ping/coverage/index.mjs';

const turn = { sessionId: 'identity', turnId: 't1', seqStart: 1, seqEnd: 2, boundarySeqs: [1, 2], rawTextSha256: 'raw-current' };
const events = [
  { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: 'old A' } },
  { seq: 2, type: 'assistant/message', data: { content: 'old A decision' } },
  { seq: 3, type: 'user/message', data: { source: { kind: 'user' }, content: 'active tail' } },
];
const turns = [
  { turnId: 'turn-1', seqStart: 1, seqEnd: 2, boundarySeqs: [1, 2], rawTextSha256: 'raw1' },
  { turnId: 'turn-3', seqStart: 3, seqEnd: 3, boundarySeqs: [3], rawTextSha256: 'raw2' },
];

test('stale summary/vector identity produces a repair item', () => {
  const plan = planCoverage({
    audit: { eligible: [turn], hold: [] },
    formalSummaries: [{ sessionId: 'identity', turnId: 't1', summarySha256: 'summary-current', rawTextSha256: 'raw-current', availableCutoff: 2 }],
    formalVectors: [{ turnId: 't1', summarySha256: 'summary-stale', vectorIndexVersion: 'old-index' }],
    indexVersion: 'new-index',
  });
  assert.ok(plan.pending > 0);
  assert.equal(plan.items[0].kind, 'vector');
});

test('duplicate fold receipt creates one pending job', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-neg-'));
  const fold = { foldId: 'same-fold', shadowedSeqs: [1, 2] };
  const first = await onFoldCoverage({ home, sessionId: 's1', fold });
  const second = await onFoldCoverage({ home, sessionId: 's1', fold });
  assert.equal(first.queued, true);
  assert.equal(second.queued, false);
  const resumed = await resumeCoverageJobs({ home, sessionId: 's1' });
  assert.equal(resumed.pending.length, 1);
});

test('catching-up manifest persists an executable plan', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-neg-'));
  const ensured = await ensureCoverage({ sessionId: 's2', home, events, turns, checkpoint: 2, activeTailStartSeq: 3, foldedSeqs: [1, 2] });
  assert.equal(ensured.status, 'catching-up');
  const resumed = await resumeCoverageJobs({ home, sessionId: 's2' });
  assert.ok(resumed.pending.length > 0);
  assert.equal(resumed.plan.checkpoint, 2);
});

test('runner persists cursor after each committed item', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-neg-'));
  const staging = createCoverageStaging({ home, sessionId: 's3', coverageId: 'c1', checkpoint: 2 });
  await runCoveragePlan({
    plan: { items: [{ kind: 'vector', turn: { turnId: 't1', seqEnd: 2 }, summary: { summaryText: 'x', summarySha256: 's', availableCutoff: 2 } }] },
    staging,
    events: [],
    config: { vector: { dimensions: 2, model: 'm' }, summary: { maxAttempts: 1 } },
    embedder: async () => [1, 0],
    indexVersion: 'v1',
  });
  assert.ok((await staging.cursor()).lastSeq >= 2);
});

test('empty or unverified staging cannot activate', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-neg-'));
  const staging = createCoverageStaging({ home, sessionId: 's4', coverageId: 'partial', checkpoint: 2 });
  await assert.rejects(() => staging.activate({ mode: 'delta-catchup', watermark: { ok: false, errors: ['incomplete'] } }));
});
