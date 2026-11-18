import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditBackfill } from '../src/turn-ping/backfill/audit.mjs';
import { createBackfillStaging } from '../src/turn-ping/backfill/staging.mjs';
import { runBackfillBatch } from '../src/turn-ping/backfill/runner.mjs';
import { verifyBackfill } from '../src/turn-ping/backfill/verify.mjs';
import { verifyWatermark, activationBoundary } from '../src/turn-ping/backfill/watermark.mjs';
import { readConfig } from '../src/turn-ping/config.mjs';

const events = [
  { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: '旧主题 A' } },
  { seq: 2, type: 'assistant/message', data: { content: '旧主题 A 的决定' } },
  { seq: 3, type: 'user/message', data: { source: { kind: 'user' }, content: 'active tail' } },
];
const turns = [
  { turnId: 'turn-000001', seqStart: 1, seqEnd: 2, boundarySeqs: [1, 2], rawTextSha256: 'raw1' },
  { turnId: 'turn-000003', seqStart: 3, seqEnd: 3, boundarySeqs: [3], rawTextSha256: 'raw2' },
];
const config = readConfig({ enabled: true, boundaries: { allowDefaultEnable: true }, vector: { dimensions: 2 } });

const fixture = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-ping-backfill-'));
  const audit = auditBackfill({ sessionId: 's1', events, turns, checkpoint: 2, activeTailStartSeq: 3, foldedSeqs: [1, 2] });
  const staging = createBackfillStaging({ home, sessionId: 's1', backfillId: 'b1', checkpoint: 2 });
  return { home, audit, staging };
};

test('audit starts at turn 1 and excludes active tail', () => {
  const { audit } = fixture();
  assert.equal(audit.eligible.length, 1);
  assert.equal(audit.eligible[0].turnId, 'turn-000001');
  assert.equal(audit.excludedActiveTail, 1);
  assert.equal(audit.eligible[0].firstFoldSeq, null);
  assert.equal(audit.eligible[0].writeOrigin, 'legacy-backfill');
});

test('runner writes staged summary/vector; resume does not call provider again', async () => {
  const { audit, staging } = fixture();
  let calls = 0;
  const provider = async () => { calls += 1; return { text: '旧主题 A 的决定。', model: 'm', usage: { total_tokens: 1 } }; };
  const embedder = async () => [1, 0];
  const first = await runBackfillBatch({ audit, staging, events, provider, embedder, config, batchSize: 4 });
  assert.equal(first.written, 1);
  assert.equal(calls, 1);
  const second = await runBackfillBatch({ audit, staging, events, provider, embedder, config, batchSize: 4 });
  assert.equal(second.written, 0);
  assert.equal(calls, 1);
  assert.equal((await staging.summaries())[0].writeOrigin, 'legacy-backfill');
  assert.equal((await staging.summaries())[0].firstFoldSeq, null);
});

test('staging is not disclosed before activation; activation merges new formal fold boundary', async () => {
  const { audit, staging } = fixture();
  const provider = async () => ({ text: '旧主题 A 的决定。', model: 'm', usage: {} });
  const embedder = async () => [1, 0];
  await runBackfillBatch({ audit, staging, events, provider, embedder, config });
  assert.equal(fs.existsSync(staging.paths.formalSummaryFile), false);
  const verificationBefore = await verifyBackfill({ audit, staging });
  assert.equal(verificationBefore.pending, 0);
  const newFormal = { turnId: 'turn-000003', summarySha256: 'new', seqStart: 3, seqEnd: 3 };
  fs.mkdirSync(path.dirname(staging.paths.formalSummaryFile), { recursive: true });
  fs.writeFileSync(staging.paths.formalSummaryFile, `${JSON.stringify(newFormal)}\n`, 'utf8');
  const summary = (await staging.summaries())[0];
  const boundary = activationBoundary({ mode: 'onfold-formal', stagingSummaries: [summary], formalBefore: [newFormal], formalAfter: [newFormal, summary] });
  assert.equal(boundary.ok, true);
  const watermark = verifyWatermark({ mode: 'onfold-formal', checkpoint: 2, backfillTurns: [turns[0]], formalTurns: [newFormal] });
  assert.equal(watermark.ok, true);
  const activated = await staging.activate({ mode: 'onfold-formal', watermark });
  assert.equal(activated.activated, true);
  const formal = fs.readFileSync(staging.paths.formalSummaryFile, 'utf8').split(/\r?\n/).filter(Boolean);
  assert.equal(formal.length, 2);

  const delta = verifyWatermark({ mode: 'delta-catchup', checkpoint: 2, backfillTurns: [turns[0]], deltaTurns: [turns[1]] });
  assert.equal(delta.ok, true);
  const overlap = verifyWatermark({ mode: 'delta-catchup', checkpoint: 2, backfillTurns: [turns[0]], deltaTurns: [turns[0]] });
  assert.equal(overlap.ok, false);
});

test('verification catches pending and raw SHA change; correct staging passes', async () => {
  const { audit, staging } = fixture();
  const provider = async () => ({ text: '旧主题 A 的决定。', model: 'm', usage: {} });
  const embedder = async () => [1, 0];
  await runBackfillBatch({ audit, staging, events, provider, embedder, config });
  const pass = await verifyBackfill({ audit, staging, rawTextBefore: 'raw', rawTextAfter: 'raw' });
  assert.equal(pass.ok, true);
  const changed = await verifyBackfill({ audit, staging, rawTextBefore: 'raw', rawTextAfter: 'changed' });
  assert.equal(changed.ok, false);
});
