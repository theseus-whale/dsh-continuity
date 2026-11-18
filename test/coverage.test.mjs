import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditCoverage } from '../src/turn-ping/coverage/audit.mjs';
import { planCoverage } from '../src/turn-ping/coverage/planner.mjs';
import { createCoverageStaging } from '../src/turn-ping/coverage/staging.mjs';
import { runCoveragePlan } from '../src/turn-ping/coverage/runner.mjs';
import { verifyCoverage } from '../src/turn-ping/coverage/verify.mjs';
import { verifyCoverageWatermark, verifyActivationBoundary } from '../src/turn-ping/coverage/watermark.mjs';
import { ensureCoverage, resumeCoverageJobs, onFoldCoverage } from '../src/turn-ping/coverage/index.mjs';
import { readConfig } from '../src/turn-ping/config.mjs';

const config = readConfig({ enabled: true, boundaries: { allowDefaultEnable: true }, vector: { dimensions: 2 } });
const events = [
  { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: 'old A' } },
  { seq: 2, type: 'assistant/message', data: { content: 'old A decision' } },
  { seq: 3, type: 'user/message', data: { source: { kind: 'user' }, content: 'active tail' } },
];
const turns = [
  { turnId: 'turn-1', seqStart: 1, seqEnd: 2, boundarySeqs: [1, 2], rawTextSha256: 'raw1' },
  { turnId: 'turn-3', seqStart: 3, seqEnd: 3, boundarySeqs: [3], rawTextSha256: 'raw2' },
];
const fixture = (sessionId = 's1') => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-'));
  const audit = auditCoverage({ sessionId, events, turns, checkpoint: 2, activeTailStartSeq: 3, foldedSeqs: [1, 2] });
  const staging = createCoverageStaging({ home, sessionId, coverageId: 'c1', checkpoint: 2 });
  return { home, audit, staging, sessionId };
};
const provider = async () => ({ text: 'old A decision.', model: 'm', usage: { total_tokens: 1 } });
const embedder = async () => [1, 0];

test('no-fold session is ready and starts zero work', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-'));
  const audit = auditCoverage({ sessionId: 'empty', events: [], turns: [], checkpoint: 0, activeTailStartSeq: 1, foldedSeqs: [] });
  const plan = planCoverage({ audit });
  assert.equal(plan.ready, true);
  assert.equal(plan.pending, 0);
  let calls = 0;
  await runCoveragePlan({ plan, staging: { appendLedger: async () => {}, coverageId: 'x' }, events: [], config, provider: async () => { calls += 1; }, embedder });
  assert.equal(calls, 0);
  const ensured = await ensureCoverage({ sessionId: 'empty', home, events: [], turns: [], checkpoint: 0, activeTailStartSeq: 1, foldedSeqs: [] });
  assert.equal(ensured.status, 'ready');
});

test('legacy long session and a different session use the same path', async () => {
  for (const sessionId of ['continuity-like', 'sonar-like']) {
    const { home, audit, staging } = fixture(sessionId);
    const first = planCoverage({ audit });
    assert.equal(first.pending, 1);
    const run = await runCoveragePlan({ plan: first, staging, events, provider, embedder, config, indexVersion: 'v1' });
    assert.equal(run.summaryWritten, 1);
    const after = planCoverage({ audit, stagedSummaries: await staging.summaries(), stagedVectors: await staging.vectors() });
    assert.equal(after.pending, 0);
  }
});

test('disabled folds are journalled and resumed without provider work', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-'));
  await onFoldCoverage({ home, sessionId: 's1', fold: { foldId: 'f1', shadowedSeqs: [1, 2] } });
  const resumed = await resumeCoverageJobs({ home, sessionId: 's1' });
  assert.equal(resumed.pending.length, 1);
  assert.equal(resumed.started, false);
});

test('summary exists but vector missing: only embedding is retried', async () => {
  const { audit, staging } = fixture();
  await staging.appendSummary({ sessionId: 's1', turnId: 'turn-1', seqStart: 1, seqEnd: 2, rawTextSha256: 'raw1', sourceViewSha256: 's', firstFoldSeq: null, availableCutoff: 2, writeOrigin: 'legacy-backfill', summaryText: 'old A decision.', summaryLength: 16, summarySha256: 'sum', status: 'complete' });
  const plan = planCoverage({ audit, stagedSummaries: await staging.summaries(), stagedVectors: [] });
  assert.equal(plan.vectorJobs, 1);
  assert.equal(plan.summaryJobs, 0);
  let providerCalls = 0;
  await runCoveragePlan({ plan, staging, events, provider: async () => { providerCalls += 1; return { text: 'x' }; }, embedder, config, indexVersion: 'v1' });
  assert.equal(providerCalls, 0);
  assert.equal((await staging.vectors()).length, 1);
});

test('proven active-tail departure is eligible even when historical firstFold is unknown', () => {
  const withFirstFold = [{ ...turns[0], firstFoldSeq: 7 }];
  const audit = auditCoverage({ sessionId: 's1', events, turns: withFirstFold, checkpoint: 2, activeTailStartSeq: 3, foldedSeqs: [] });
  assert.equal(audit.eligible.length, 1);
  assert.equal(audit.eligible[0].foldVerified, false);
  assert.equal(audit.eligible[0].firstFoldSeq, 7);
  assert.equal(audit.eligible[0].status, 'legacy-complete');
});

test('permanent HOLD is terminal and does not call provider', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-'));
  const audit = auditCoverage({ sessionId: 's1', events, turns, checkpoint: 2, activeTailStartSeq: 3, foldedSeqs: [], unprovableTurnIds: ['turn-1'] });
  const plan = planCoverage({ audit });
  assert.equal(plan.hold, 1);
  assert.equal(plan.ready, true);
  const ensured = await ensureCoverage({ sessionId: 's1', home, events, turns, checkpoint: 2, activeTailStartSeq: 3, foldedSeqs: [], unprovableTurnIds: ['turn-1'] });
  assert.equal(ensured.status, 'degraded');
});

test('activation boundary preserves a new formal fold and watermark has no overlap', async () => {
  const { staging, audit } = fixture();
  await runCoveragePlan({ plan: planCoverage({ audit }), staging, events, provider, embedder, config, indexVersion: 'v1' });
  const staged = await staging.summaries();
  const newFormal = { turnId: 'turn-3', summarySha256: 'new', seqStart: 3, seqEnd: 3 };
  fs.mkdirSync(path.dirname(staging.paths.formalSummaryFile), { recursive: true });
  fs.writeFileSync(staging.paths.formalSummaryFile, `${JSON.stringify(newFormal)}\n`, 'utf8');
  const boundary = verifyActivationBoundary({ mode: 'onfold-formal', stagingSummaries: staged, formalBefore: [newFormal], formalAfter: [newFormal, staged[0]] });
  assert.equal(boundary.ok, true);
  const wm = verifyCoverageWatermark({ mode: 'onfold-formal', checkpoint: 2, backfillTurns: [turns[0]], formalTurns: [newFormal] });
  assert.equal(wm.ok, true);
  await staging.activate({ mode: 'onfold-formal', watermark: wm });
  const pointer = await staging.activePointer();
  assert.ok(pointer.versionId);
  const activeSummaries = fs.readFileSync(path.join(staging.paths.activationRoot, pointer.versionId, 'summaries.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
  assert.equal(activeSummaries.length, 2);
});
