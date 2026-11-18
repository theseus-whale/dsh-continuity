import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureCoverage, getCoverageStatus } from '../src/turn-ping/coverage/index.mjs';
import { createCoverageStaging } from '../src/turn-ping/coverage/staging.mjs';

const events = [
  { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: 'old A' } },
  { seq: 2, type: 'assistant/message', data: { content: 'old A decision' } },
  { seq: 3, type: 'user/message', data: { source: { kind: 'user' }, content: 'active tail' } },
];
const turns = [
  { turnId: 'turn-1', seqStart: 1, seqEnd: 2, boundarySeqs: [1, 2], rawTextSha256: 'raw1' },
  { turnId: 'turn-3', seqStart: 3, seqEnd: 3, boundarySeqs: [3], rawTextSha256: 'raw2' },
];
const base = { events, turns, checkpoint: 2, activeTailStartSeq: 3, foldedSeqs: [1, 2] };
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-boundary-'));

test('ensureCoverage enforces requiredIndexVersion', async () => {
  const ensured = await ensureCoverage({
    ...base,
    home: home(),
    sessionId: 'version',
    indexVersion: 'required-v2',
    formalSummaries: [{ sessionId: 'version', turnId: 'turn-1', rawTextSha256: 'raw1', summarySha256: 'sum1', availableCutoff: 2 }],
    formalVectors: [{ turnId: 'turn-1', summarySha256: 'sum1', vectorIndexVersion: 'old-v1' }],
  });
  assert.equal(ensured.plan.indexVersion, 'required-v2');
  assert.equal(ensured.plan.ready, false);
  assert.ok(ensured.plan.pending > 0);
});

test('summary without raw identity is not covered', async () => {
  const ensured = await ensureCoverage({
    ...base,
    home: home(),
    sessionId: 'raw',
    indexVersion: 'v1',
    formalSummaries: [{ sessionId: 'raw', turnId: 'turn-1', summarySha256: 'sum1', availableCutoff: 2 }],
    formalVectors: [{ turnId: 'turn-1', summarySha256: 'sum1', vectorIndexVersion: 'v1' }],
  });
  assert.equal(ensured.plan.ready, false);
  assert.ok(ensured.plan.pending > 0);
});

test('getCoverageStatus includes persisted plan pending', async () => {
  const dir = home();
  const ensured = await ensureCoverage({ ...base, home: dir, sessionId: 'pending' });
  const status = await getCoverageStatus({ home: dir, sessionId: 'pending' });
  assert.equal(status.pending, ensured.plan.pending);
  assert.equal(status.pending, status.planPending);
});

test('activation rejects self-reported incomplete watermark', async () => {
  const staging = createCoverageStaging({ home: home(), sessionId: 'partial', coverageId: 'partial', checkpoint: 10 });
  await staging.appendSummary({ sessionId: 'partial', turnId: 'only-one', rawTextSha256: 'raw1', summarySha256: 'sum1', availableCutoff: 10 });
  await staging.appendVector({ turnId: 'only-one', summarySha256: 'sum1', vectorIndexVersion: 'v1' });
  await assert.rejects(() => staging.activate({ mode: 'delta-catchup', watermark: { ok: true, eligible: 2, covered: 1, pending: 1 } }));
});
