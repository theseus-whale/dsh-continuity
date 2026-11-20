import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveTurnPingConfig } from '../src/turn-ping/local-config.mjs';
import { installTurnPing, recordTurnPingInstallIssue } from '../src/turn-ping/install.mjs';
import { installTurnPingPreStep } from '../src/turn-ping/pre-step.mjs';
import { continuityState, resetState } from '../src/state.mjs';

const publicConfig = { enabled: false, mode: 'shadow', localConfig: './local/memory-resonance.json' };
const local = { enabled: true, mode: 'opt-in', boundaries: { allowDefaultEnable: true, allowLiveInjection: true }, autoRecall: { mode: 'legacy' }, provider: 'local-provider', model: 'local-model', embeddingModel: './models/Xenova/bge-small-zh-v1.5', sessionIds: ['session-local-a', 'session-local-b'] };
function overlayHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'host-overlay-'));
  fs.mkdirSync(path.join(home, 'local'), { recursive: true });
  fs.writeFileSync(path.join(home, 'local', 'memory-resonance.json'), JSON.stringify(local), 'utf8');
  return home;
}
function makeSession(id) {
  let seq = 1;
  const nodes = [1];
  const events = new Map([[1, { seq: 1, type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } } }]]);
  return {
    id,
    surface: { nodes },
    eventAt: (s) => events.get(s) ?? null,
    snapshotEvents: () => [...events.values()],
    append(type, message, opts = {}) {
      seq += 1;
      const event = { seq, type, data: { message } };
      if (opts.surfaceOp === 'append') nodes.push(seq);
      events.set(seq, event);
      return event;
    },
  };
}
function listenerFor(config, beforeAnswer) {
  const listeners = new Map();
  const ctx = { on: (name, fn) => listeners.set(name, fn) };
  installTurnPingPreStep({ ctx, config: { ...config, ruleCue: { mode: 'off' } }, beforeAnswer, log: { warn() {} } });
  return listeners.get('agent/pre-step');
}

test('missing overlay leaves Host memory resonance disabled', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'host-overlay-missing-'));
  const resolved = resolveTurnPingConfig(publicConfig, { home });
  assert.equal(resolved.enabled, false);
  assert.equal(installTurnPing({ config: resolved }).enabled, false);
});

test('Host local overlay enables provider/install/pre-step for exactly two allowlisted sessions', async () => {
  const home = overlayHome();
  const resolved = resolveTurnPingConfig(publicConfig, { home });
  assert.equal(resolved.enabled, true);
  assert.deepEqual(resolved.sessionIds, ['session-local-a', 'session-local-b']);
  assert.equal(resolved.provider, 'local-provider');
  assert.equal(resolved.model, 'local-model');

  const installed = installTurnPing({ config: resolved, provider: async () => ({ text: 'x', model: 'm', usage: null }), embedder: async () => Array(512).fill(0), home });
  assert.equal(installed.enabled, true);

  const beforeAnswer = async () => ({ enabled: true, H: 1, ping: { text: '[记忆共振] HIT' } });
  const listener = listenerFor(resolved, beforeAnswer);
  for (const id of ['session-local-a', 'session-local-b']) {
    const session = makeSession(id);
    const decision = await listener({ agent: { session }, step: 1 }, async () => ({ messages: [{ role: 'user', content: [{ type: 'text', text: 'query' }], source: { kind: 'user' } }] }));
    assert.equal(decision.messages.length, 2);
    assert.equal(decision.messages.at(-1).source.kind, 'memory-cue');
  }
  const other = makeSession('session-not-allowed');
  const decision = await listener({ agent: { session: other }, step: 1 }, async () => ({ messages: [{ role: 'user', content: [{ type: 'text', text: 'query' }], source: { kind: 'user' } }] }));
  assert.equal(decision.messages.length, 1);
});

test('enabled overlay requires ids, rejects malformed, and provider absence is explicit', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'host-overlay-invalid-'));
  fs.mkdirSync(path.join(home, 'local'), { recursive: true });
  const file = path.join(home, 'local', 'memory-resonance.json');
  fs.writeFileSync(file, JSON.stringify({ enabled: true }), 'utf8');
  assert.throws(() => resolveTurnPingConfig(publicConfig, { home }), /non-empty sessionIds/);
  fs.writeFileSync(file, JSON.stringify({ enabled: true, sessionIds: [] }), 'utf8');
  assert.throws(() => resolveTurnPingConfig(publicConfig, { home }), /non-empty sessionIds/);
  fs.writeFileSync(file, '{broken', 'utf8');
  assert.throws(() => resolveTurnPingConfig(publicConfig, { home }));
  const resolved = resolveTurnPingConfig(publicConfig, { home: overlayHome() });
  assert.equal(installTurnPing({ config: resolved }).reason, 'summary-provider-unavailable');
});

test('turn-ping install failures reach gate errors, DEBUG diagnostics and the panel state', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'host-install-diagnostics-'));
  const warnings = [];
  resetState();
  try {
    recordTurnPingInstallIssue({
      home,
      config: { diagnostics: { enabled: true } },
      error: new Error('ctx.llm adapter could not initialize'),
      log: { warn: message => warnings.push(message) },
    });
    const readLast = file => fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line)).at(-1);
    const gate = readLast(path.join(home, 'gate-errors.jsonl'));
    const debug = readLast(path.join(home, 'turn-ping-prestep-debug.jsonl'));
    assert.equal(gate.code, 'turn-ping-install-failed');
    assert.match(gate.message, /ctx\.llm adapter/);
    assert.equal(debug.kind, 'install-error');
    assert.equal(debug.code, gate.code);
    assert.equal(continuityState.lastError.key, 'turn-ping-install-failed');
    assert.match(continuityState.lastError.message, /ctx\.llm adapter/);
    assert.equal(warnings.length, 1);
  } finally {
    resetState();
  }
});
