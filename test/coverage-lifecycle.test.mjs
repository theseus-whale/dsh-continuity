import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openSessionCoverage, resumeStartupSessions, hostSnapshot } from '../src/turn-ping/coverage/lifecycle.mjs';
import { createCoverageStaging } from '../src/turn-ping/coverage/staging.mjs';
import { readConfig } from '../src/turn-ping/config.mjs';
import { createTurnPingHost } from '../src/turn-ping/host.mjs';
import { createReadSeqRangeTool } from '../src/turn-ping/read-tool.mjs';

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
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-life-'));
const base = { events, turns, checkpoint: 2, activeTailStartSeq: 3, foldedSeqs: [1, 2], indexVersion: 'v1' };

test('session open builds initial plan; startup runner resumes actual work', async () => {
  const dir = home();
  const opened = await openSessionCoverage({ ...base, home: dir, sessionId: 's1' });
  assert.equal(opened.plan.pending, 1);
  const resumed = await resumeStartupSessions({
    home: dir,
    sessions: ['s1'],
    eventsBySession: { s1: events },
    config,
    provider: async () => ({ text: 'old A decision.', model: 'm', usage: {} }),
    embedder: async () => [1, 0],
  });
  assert.equal(resumed[0].summaryWrites, 1);
  assert.equal(resumed[0].status, 'catching-up');
  assert.equal(resumed[0].activeSummaries, 0);
  assert.equal(resumed[0].activeVectors, 0);
  const second = await resumeStartupSessions({ home: dir, sessions: ['s1'], config, provider: async () => { throw new Error('must not scan'); }, embedder: async () => { throw new Error('must not embed'); } });
  assert.equal(second[0].rawScan, 0);
});

test('already-audited session only plans increment, no cold fan-out', async () => {
  const dir = home();
  await openSessionCoverage({ ...base, home: dir, sessionId: 's1' });
  const resumed = await resumeStartupSessions({
    home: dir,
    sessions: ['s1'],
    eventsBySession: { s1: events },
    config,
    provider: async () => ({ text: 'old A decision.', model: 'm', usage: {} }),
    embedder: async () => [1, 0],
  });
  assert.equal(resumed.length, 1);
  await openSessionCoverage({ ...base, home: dir, sessionId: 's1' });
  const cold = path.join(dir, 'sessions', 'cold');
  fs.mkdirSync(cold, { recursive: true });
  const startup = await resumeStartupSessions({ home: dir, sessions: ['s1'], config, provider: async () => { throw new Error('cold must not run'); }, embedder: async () => { throw new Error('cold must not run'); } });
  assert.equal(startup.length, 1);
});

test('autoActivate runs, verifies, activates, then retrieval works and restart is zero', async () => {
  const dir = home();
  const activatedConfig = { ...config, autoActivate: true };
  await openSessionCoverage({ ...base, home: dir, sessionId: 's1' });
  const first = await resumeStartupSessions({
    home: dir,
    sessions: ['s1'],
    eventsBySession: { s1: events },
    config: activatedConfig,
    provider: async () => ({ text: 'old A decision.', model: 'm', usage: {} }),
    embedder: async () => [1, 0],
  });
  assert.equal(first[0].status, 'ready');
  assert.equal(first[0].activeSummaries, 1);
  assert.equal(first[0].activeVectors, 1);
  const second = await resumeStartupSessions({ home: dir, sessions: ['s1'], config: activatedConfig, provider: async () => { throw new Error('must not run'); }, embedder: async () => { throw new Error('must not run'); } });
  assert.equal(second[0].rawScan, 0);
  assert.equal(second[0].status, 'ready');
  const host = createTurnPingHost({
    config: { enabled: true, boundaries: { allowDefaultEnable: true }, vector: { dimensions: 2 } },
    home: dir,
    provider: async () => ({ text: 'old A decision.', model: 'm', usage: {} }),
    embedder: async () => [1, 0],
  });
  const answer = await host.beforeAnswer({ sessionId: 's1', query: 'old A', cutoff: 2, turns });
  assert.ok(answer.ping.text.includes('turn-1'));
  const readTool = createReadSeqRangeTool({ sessionQuery: { readSession: async () => ({ events }) } });
  const raw = JSON.parse(await readTool.execute({ fromSeq: 1, toSeq: 2 }, { agent: { session: { id: 's1' } } }));
  assert.ok(raw.text.includes('old A'));
});

test('host snapshot supplies cutoff/active tail', async () => {
  const snap = hostSnapshot({ sessionId: 's1', checkpoint: 2, activeTailStartSeq: 3, scope: 'session' });
  const opened = await openSessionCoverage({ ...base, ...snap, home: home(), sessionId: 's1', events, turns });
  assert.equal(opened.audit.excludedActiveTail, 1);
  assert.equal(opened.audit.eligible.length, 1);
});

test('ready with active coverage performs zero work', async () => {
  const dir = home();
  const staging = createCoverageStaging({ home: dir, sessionId: 'ready', coverageId: 'c1', checkpoint: 2 });
  await staging.appendSummary({ sessionId: 'ready', turnId: 'turn-1', rawTextSha256: 'raw1', summarySha256: 'sum1', availableCutoff: 2 });
  await staging.appendVector({ turnId: 'turn-1', summarySha256: 'sum1', vectorIndexVersion: 'v1' });
  await staging.activate({ mode: 'onfold-formal', watermark: { ok: true } });
  await openSessionCoverage({ ...base, home: dir, sessionId: 'ready' });
  let calls = 0;
  const ready = await resumeStartupSessions({ home: dir, sessions: ['ready'], config, provider: async () => { calls += 1; throw new Error('must not run'); }, embedder: async () => { calls += 1; throw new Error('must not run'); } });
  assert.equal(ready[0].rawScan, 0);
  assert.equal(calls, 0);
  assert.ok(['ready', 'degraded'].includes(ready[0].status));
});

test('second activation with active pointer preserves concurrent append', async () => {
  const dir = home();
  const first = createCoverageStaging({ home: dir, sessionId: 's1', coverageId: 'c1', checkpoint: 2 });
  await first.appendSummary({ sessionId: 's1', turnId: 'turn-1', rawTextSha256: 'raw1', summarySha256: 'sum1', availableCutoff: 2 });
  await first.appendVector({ turnId: 'turn-1', summarySha256: 'sum1', vectorIndexVersion: 'v1' });
  const one = await first.activate({ mode: 'onfold-formal', watermark: { ok: true } });
  const second = createCoverageStaging({ home: dir, sessionId: 's1', coverageId: 'c2', checkpoint: 2 });
  await second.appendSummary({ sessionId: 's1', turnId: 'turn-2', rawTextSha256: 'raw2', summarySha256: 'sum2', availableCutoff: 2 });
  await second.appendVector({ turnId: 'turn-2', summarySha256: 'sum2', vectorIndexVersion: 'v1' });
  const two = await second.activate({
    mode: 'onfold-formal',
    watermark: { ok: true },
    beforeCommit: async () => {
      const base = path.join(second.paths.activationRoot, one.versionId);
      fs.mkdirSync(base, { recursive: true });
      fs.appendFileSync(path.join(base, 'summaries.jsonl'), `${JSON.stringify({ sessionId: 's1', turnId: 'turn-9', rawTextSha256: 'raw9', summarySha256: 'sum9', availableCutoff: 2 })}\n`);
      fs.appendFileSync(path.join(base, 'vectors.jsonl'), `${JSON.stringify({ turnId: 'turn-9', summarySha256: 'sum9', vectorIndexVersion: 'v1' })}\n`);
    },
  });
  const rows = fs.readFileSync(path.join(second.paths.activationRoot, two.versionId, 'summaries.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => row.turnId).sort(), ['turn-1', 'turn-2', 'turn-9']);
});

test('activation preserves a concurrent formal append at boundary', async () => {
  const dir = home();
  const staging = createCoverageStaging({ home: dir, sessionId: 's1', coverageId: 'c1', checkpoint: 2 });
  await staging.appendSummary({ sessionId: 's1', turnId: 'turn-1', rawTextSha256: 'raw1', summarySha256: 'sum1', availableCutoff: 2 });
  await staging.appendVector({ turnId: 'turn-1', summarySha256: 'sum1', vectorIndexVersion: 'v1' });
  const activated = await staging.activate({
    mode: 'onfold-formal',
    watermark: { ok: true, eligible: 1, covered: 1, pending: 0 },
    beforeCommit: async () => {
      fs.mkdirSync(path.dirname(staging.paths.formalSummaryFile), { recursive: true });
      fs.mkdirSync(path.dirname(staging.paths.formalVectorFile), { recursive: true });
      fs.writeFileSync(staging.paths.formalSummaryFile, `${JSON.stringify({ sessionId: 's1', turnId: 'turn-9', rawTextSha256: 'raw9', summarySha256: 'sum9', availableCutoff: 2 })}\n`, 'utf8');
      fs.writeFileSync(staging.paths.formalVectorFile, `${JSON.stringify({ turnId: 'turn-9', summarySha256: 'sum9', vectorIndexVersion: 'v1' })}\n`, 'utf8');
    },
  });
  assert.equal(activated.activated, true);
  const active = JSON.parse(fs.readFileSync(path.join(staging.paths.activationRoot, activated.versionId, 'summaries.jsonl'), 'utf8').split(/\r?\n/)[0]);
  assert.equal(active.turnId, 'turn-1');
  const rows = fs.readFileSync(path.join(staging.paths.activationRoot, activated.versionId, 'summaries.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
  assert.equal(rows.length, 2);
});
