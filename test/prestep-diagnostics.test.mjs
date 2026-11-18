import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installTurnPingPreStep } from '../src/turn-ping/pre-step.mjs';

const canary = '[memory-canary] peer canary';
const peer = { role: 'user', content: [{ type: 'text', text: canary }], source: { kind: 'user', peer: true, peerFrom: 'dsh/session-ce5' } };
const runtime = { role: 'user', content: [{ type: 'text', text: 'Current runtime context. snapshot' }], source: { kind: 'runtime-context' } };

test('pre-step diagnostics record peer ping append without message text', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-ping-diag-'));
  const debugPath = path.join(dir, 'prestep.jsonl');
  const listeners = new Map();
  const ctx = { on: (name, fn) => listeners.set(name, fn) };
  let calls = 0;
  installTurnPingPreStep({
    ctx,
    config: { mode: 'opt-in', boundaries: { allowLiveInjection: true }, diagnostics: { enabled: true } },
    beforeAnswer: async () => { calls += 1; return { enabled: true, H: 1, ping: { text: '[记忆共振] turn-001981', bytes: 20 } }; },
    contextMessage: (text) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } }),
    diagnosticPath: debugPath,
  });
  const session = { id: 's1', surface: { nodes: [10] }, snapshotEvents: () => [] };
  const out = await listeners.get('agent/pre-step')({ agent: { session }, step: 1 }, async () => ({ messages: [runtime, peer] }));
  assert.equal(calls, 1);
  assert.ok(out.messages.at(-1).content[0].text.includes('turn-001981'));
  const rows = fs.readFileSync(debugPath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.ok(rows.some((row) => row.kind === 'query' && row.sourcePeer === true));
  assert.ok(rows.some((row) => row.kind === 'before-answer' && row.H === 1));
  assert.ok(rows.some((row) => row.kind === 'return' && row.appended === true && row.lastHasPing === true));
  assert.equal(JSON.stringify(rows).includes(canary), false);
});

test('pre-step diagnostics record no-query and do not call beforeAnswer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-ping-diag-'));
  const debugPath = path.join(dir, 'prestep.jsonl');
  const listeners = new Map();
  const ctx = { on: (name, fn) => listeners.set(name, fn) };
  let calls = 0;
  installTurnPingPreStep({
    ctx,
    config: { mode: 'opt-in', boundaries: { allowLiveInjection: true }, diagnostics: { enabled: true } },
    beforeAnswer: async () => { calls += 1; return { enabled: true, H: 1, ping: { text: 'x', bytes: 1 } }; },
    contextMessage: () => ({}),
    diagnosticPath: debugPath,
  });
  await listeners.get('agent/pre-step')({ agent: { session: { id: 's1', surface: { nodes: [10] }, snapshotEvents: () => [] } }, step: 1 }, async () => ({ messages: [runtime] }));
  assert.equal(calls, 0);
  const rows = fs.readFileSync(debugPath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.ok(rows.some((row) => row.kind === 'skipped' && row.reason === 'no-query-or-cutoff'));
});
