import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wireCoverageHost, COVERAGE_HOST_CAPABILITIES } from '../src/turn-ping/coverage/host-wire.mjs';
import { createCoverageJournal } from '../src/turn-ping/coverage/journal.mjs';
import { createCoverageStaging } from '../src/turn-ping/coverage/staging.mjs';

const events = [
  { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: 'old A' } },
  { seq: 2, type: 'assistant/message', data: { content: 'old A decision' } },
  { seq: 3, type: 'user/message', data: { source: { kind: 'user' }, content: 'active tail' } },
  { seq: 4, type: 'compaction/summary', data: { compactionId: 'f1', shadowedSeqs: [1, 2] } },
];
const session = { id: 's1', snapshotEvents: () => events, surface: { nodes: [3] } };

test('coverage host is not wired when disabled', () => {
  const listeners = new Map();
  const ctx = { on: (name, fn) => listeners.set(name, fn) };
  const wired = wireCoverageHost({ ctx, config: { enabled: false }, home: path.join(os.tmpdir(), 'disabled') });
  assert.equal(wired.wired, false);
  assert.equal(listeners.size, 0);
});

test('real agent/created event opens coverage without provider generation', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-host-'));
  const listeners = new Map();
  const ctx = { on: (name, fn) => listeners.set(name, fn) };
  const wired = wireCoverageHost({ ctx, config: { enabled: true, indexVersion: 'v1', vector: { dimensions: 2 } }, home });
  assert.equal(wired.wired, true);
  assert.equal(COVERAGE_HOST_CAPABILITIES.startupResume.startsWith('unavailable'), true);
  await listeners.get('agent/created')({ agent: { session } });
  const journal = createCoverageJournal({ home, sessionId: 's1' });
  const manifest = await journal.manifest();
  assert.equal(manifest.status, 'catching-up');
  assert.ok(manifest.pendingJobs > 0);
});

test('created open runs the per-session runner with fake adapters', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-host-'));
  const listeners = new Map();
  const ctx = { on: (name, fn) => listeners.set(name, fn) };
  let providerCalls = 0;
  wireCoverageHost({
    ctx,
    config: { enabled: true, indexVersion: 'v1', vector: { dimensions: 2 } },
    home,
    provider: async () => { providerCalls += 1; return { text: 'old A decision.', model: 'fake', usage: {} }; },
    embedder: async () => [1, 0],
  });
  await listeners.get('agent/created')({ agent: { session } });
  assert.equal(providerCalls, 1);
  const staging = createCoverageStaging({ home, sessionId: 's1', coverageId: 'initial-4-1', checkpoint: 4 });
  const summaries = await staging.summaries();
  assert.equal(summaries.length, 1);
  const journal = createCoverageJournal({ home, sessionId: 's1' });
  const manifest = await journal.manifest();
  assert.equal(manifest.status, 'catching-up');
  assert.equal(manifest.activationPending, true);
});

test('pre-step fallback opens a session when created did not fire', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-host-'));
  const listeners = new Map();
  const ctx = { on: (name, fn) => listeners.set(name, fn) };
  let providerCalls = 0;
  const wired = wireCoverageHost({
    ctx,
    config: { enabled: true, vector: { dimensions: 2 } },
    home,
    provider: async () => { providerCalls += 1; return { text: 'old A decision.', model: 'fake', usage: {} }; },
    embedder: async () => [1, 0],
  });
  await listeners.get('agent/pre-step')({ agent: { session } }, async () => ({}));
  await Promise.all(wired.jobs());
  await listeners.get('agent/pre-step')({ agent: { session } }, async () => ({}));
  assert.equal(providerCalls, 1);
});

test('concurrent created events for one session run one job', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-host-'));
  const listeners = new Map();
  const ctx = { on: (name, fn) => listeners.set(name, fn) };
  let providerCalls = 0;
  wireCoverageHost({
    ctx,
    config: { enabled: true, vector: { dimensions: 2 } },
    home,
    provider: async () => { providerCalls += 1; return { text: 'old A decision.', model: 'fake', usage: {} }; },
    embedder: async () => [1, 0],
  });
  await Promise.all([
    listeners.get('agent/created')({ agent: { session } }),
    listeners.get('session/created')(session),
  ]);
  assert.equal(providerCalls, 1);
});

test('pre-step fallback does not block next on a slow provider', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-host-'));
  const listeners = new Map();
  const ctx = { on: (name, fn) => listeners.set(name, fn) };
  let release;
  let providerStarted;
  const started = new Promise((resolve) => { providerStarted = resolve; });
  let providerCalls = 0;
  wireCoverageHost({
    ctx,
    config: { enabled: true, vector: { dimensions: 2 } },
    home,
    provider: async () => {
      providerCalls += 1;
      providerStarted();
      await new Promise((resolve) => { release = resolve; });
      return { text: 'old A decision.', model: 'fake', usage: {} };
    },
    embedder: async () => [1, 0],
  });
  let nextResolved = false;
  const p = listeners.get('agent/pre-step')({ agent: { session } }, async () => { nextResolved = true; return {}; });
  await p;
  assert.equal(nextResolved, true);
  await started;
  const duplicate = listeners.get('agent/pre-step')({ agent: { session } }, async () => ({}));
  await duplicate;
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(providerCalls, 1);
});

test('invalid snapshot does not permanently mark session seen', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-host-'));
  const listeners = new Map();
  const ctx = { on: (name, fn) => listeners.set(name, fn) };
  let providerCalls = 0;
  wireCoverageHost({
    ctx,
    config: { enabled: true, vector: { dimensions: 2 } },
    home,
    provider: async () => { providerCalls += 1; return { text: 'old A decision.', model: 'fake', usage: {} }; },
    embedder: async () => [1, 0],
  });
  const invalid = { id: 's1', snapshotEvents: () => [], surface: { nodes: [] } };
  await listeners.get('agent/created')({ agent: { session: invalid } });
  assert.equal(providerCalls, 0);
  await listeners.get('agent/created')({ agent: { session } });
  assert.equal(providerCalls, 1);
});

test('session/event fold reaches the journal idempotently', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-host-'));
  const listeners = new Map();
  const ctx = { on: (name, fn) => listeners.set(name, fn) };
  wireCoverageHost({ ctx, config: { enabled: true, vector: { dimensions: 2 } }, home });
  await listeners.get('session/event')(session, events[3]);
  await listeners.get('session/event')(session, events[3]);
  const journal = createCoverageJournal({ home, sessionId: 's1' });
  const jobs = await journal.jobs();
  assert.equal(jobs.length, 1);
});

