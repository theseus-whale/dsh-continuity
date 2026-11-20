import test from 'node:test';
import assert from 'node:assert/strict';
import { turnPingUserText, normalizeTurnPingUserMessage } from '../src/turn-ping/query.mjs';
import { installTurnPingPreStep } from '../src/turn-ping/pre-step.mjs';

const canary = '[memory-canary] 你之前对 dsh-world 的 A note/alarm 和 B archive 是怎么取舍的？还有 C/D/E/F 怎么处理？只按你记得的回答。';
const peerMessage = {
  role: 'user',
  content: [{ type: 'text', text: canary }],
  source: { kind: 'user', peer: true, peerFrom: 'dsh/session-ce5ff26d-42ed-4df0-8d93-b15eb3d20c7b' },
};
const runtime = { role: 'user', content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier.' }], source: { kind: 'runtime-context' } };
const time = { role: 'user', content: [{ type: 'text', text: 'Time sampled while preparing turn 64, step 1.' }], source: { kind: 'time-context' } };

test('peer user message is a valid turn-ping query but runtime/time are not', () => {
  assert.equal(turnPingUserText([runtime, time, peerMessage]), canary);
  assert.equal(turnPingUserText([runtime, time]), '');
  assert.equal(turnPingUserText([{ role: 'user', content: 'normal user', source: { kind: 'user' } }]), 'normal user');
  assert.equal(turnPingUserText([{ role: 'user', content: 'peer kind', source: { kind: 'peer' } }]), 'peer kind');
  const normalized = normalizeTurnPingUserMessage(peerMessage);
  assert.equal(normalized.source.kind, 'user');
  assert.equal(normalized.source.peer, false);
  assert.equal(normalized.source.peerFrom, peerMessage.source.peerFrom);
});

test('actual pre-step handler retrieves and appends memory resonance for peer message', async () => {
  const listeners = new Map();
  const ctx = { on: (name, fn) => listeners.set(name, fn) };
  const calls = [];
  installTurnPingPreStep({
    ctx,
    config: { mode: 'opt-in', boundaries: { allowLiveInjection: true }, ruleCue: { mode: 'off' } },
    beforeAnswer: async (args) => { calls.push(args); return { enabled: true, ping: { text: '[记忆共振] HIT turn-001981' }, H: 1 }; },
    contextMessage: (text) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } }),
  });
  const session = { id: 'session-test', surface: { nodes: [6084] }, snapshotEvents: () => [] };
  const decision = { messages: [runtime, time, peerMessage] };
  const out = await listeners.get('agent/pre-step')({ agent: { session } }, async () => decision);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query, canary);
  assert.equal(calls[0].cutoff, 6084);
  assert.ok(out.messages.at(-1).content[0].text.includes('turn-001981'));

  const noCall = [];
  const out2 = await listeners.get('agent/pre-step')({ agent: { session } }, async () => ({ messages: [runtime, time] }));
  assert.equal(noCall.length, 0);
  assert.equal(out2.messages.length, 2);
});
