import test from 'node:test';
import assert from 'node:assert/strict';
import { installTurnPingPreStep } from '../src/turn-ping/pre-step.mjs';
import { turnPingUserText } from '../src/turn-ping/query.mjs';
import { memoryCueMessage, retiredMemoryCueMessage, isMemoryCueMessage } from '../src/memory-cue.mjs';
import { classifyLegacyCue } from '../src/legacy-cue-audit.mjs';
import { buildSourceView } from '../src/turn-ping/source-view.mjs';
import { buildTurnsFromEvents } from '../src/turn-ping/host.mjs';
import { buildRawChunks } from '../src/fullseed/chunks.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const peer = { role: 'user', content: [{ type: 'text', text: '[memory-canary] question' }], source: { kind: 'user', peer: true, peerFrom: 'x' } };
const runtime = { role: 'user', content: [{ type: 'text', text: 'Current runtime context.' }], source: { kind: 'runtime-context' } };

function fakeSession() {
  let seq = 100;
  const nodes = [10];
  const events = new Map([[10, { seq: 10, type: 'user/message', data: { message: runtime } }]]);
  const session = {
    id: 's1',
    surface: { nodes },
    eventAt: (s) => events.get(s) ?? null,
    append(type, message, opts = {}) {
      seq += 1;
      const event = { seq, type, data: { message } };
      if (opts.surfaceOp === 'append') nodes.push(seq);
      else if (opts.surfaceOp?.op === 'replace') {
        events.set(opts.surfaceOp.startSeq, event);
      }
      events.set(seq, event);
      return event;
    },
  };
  return session;
}

function stepAppend(session, decision) {
  for (const message of decision.messages) {
    if (message.source?.kind === 'runtime-context') continue;
    session.append('user/message', message, { surfaceOp: 'append' });
  }
}

function pingNodes(session) {
  return session.surface.nodes.map((seq) => session.eventAt(seq)).filter((event) => {
    const message = event?.data?.message ?? event?.data;
    return isMemoryCueMessage(message) && message.content?.[0]?.text;
  });
}

function makePreStep({ session, answer, debugPath }) {
  const listeners = new Map();
  const ctx = { on: (name, fn) => listeners.set(name, fn) };
  installTurnPingPreStep({
    ctx,
    config: { mode: 'opt-in', boundaries: { allowLiveInjection: true }, autoRecall: { mode: 'legacy' }, diagnostics: { enabled: true } },
    beforeAnswer: typeof answer === 'function' ? answer : async () => answer,
    contextMessage: () => ({ role: 'user', content: [{ type: 'text', text: 'unused' }], source: { kind: 'runtime-context' } }),
    diagnosticPath: debugPath,
  });
  return { session, listener: listeners.get('agent/pre-step') };
}

test('host step appends memory-cue into provider surface', async () => {
  const session = fakeSession();
  const { listener } = makePreStep({ session, answer: { enabled: true, H: 1, ping: { text: '[记忆共振] HIT' } } });
  const decision = await listener({ agent: { session }, step: 1 }, async () => ({ messages: [runtime, peer] }));
  const ping = decision.messages.at(-1);
  assert.equal(ping.source.kind, 'memory-cue');
  stepAppend(session, decision);
  assert.equal(pingNodes(session).length, 1);
  assert.ok(pingNodes(session)[0].data.message.content[0].text.includes('HIT'));
});

test('memoryCueMessage and retiredMemoryCueMessage use only new source kinds', () => {
  assert.equal(memoryCueMessage('x').source.kind, 'memory-cue');
  assert.equal(retiredMemoryCueMessage().source.kind, 'memory-cue-retired');
  assert.equal(classifyLegacyCue({ source: { kind: 'turn-ping-memory' } }), 'active-legacy');
  assert.equal(classifyLegacyCue({ source: { kind: 'turn-ping-retired' } }), 'retired-legacy');
});

test('two pre-steps keep only the second nonempty standing cue', async () => {
  let calls = 0;
  const session = fakeSession();
  const { listener } = makePreStep({ session, answer: async () => { calls += 1; return { enabled: true, H: 1, ping: { text: `[记忆共振] generation-${calls}` } }; } });
  const first = await listener({ agent: { session }, step: 1 }, async () => ({ messages: [peer] }));
  stepAppend(session, first);
  assert.equal(pingNodes(session).length, 1);
  const second = await listener({ agent: { session }, step: 2 }, async () => ({ messages: [peer] }));
  stepAppend(session, second);
  assert.equal(pingNodes(session).length, 1);
  const text = (pingNodes(session)[0].data.message ?? pingNodes(session)[0].data).content[0].text;
  assert.ok(text.includes('generation-2'));
  assert.equal(text.includes('generation-1'), false);
});

test('production direct-data shape replaces first cue with second', async () => {
  let calls = 0;
  const nodes = [10];
  const events = new Map([[10, { seq: 10, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'runtime' }], source: { kind: 'runtime-context' } } }]]);
  const appended = [];
  let seq = 100;
  const session = {
    id: 'production-shape',
    surface: { nodes },
    eventAt: (s) => events.get(s) ?? null,
    append(type, message, opts = {}) {
      seq += 1;
      const event = { seq, type, data: message };
      appended.push({ seq, opts });
      if (opts.surfaceOp === 'append') nodes.push(seq);
      else if (opts.surfaceOp?.op === 'replace') events.set(opts.surfaceOp.startSeq, event);
      events.set(seq, event);
      return event;
    },
  };
  const { listener } = makePreStep({ session, answer: async () => { calls += 1; return { enabled: true, H: 1, ping: { text: `[记忆共振] generation-${calls}` } }; } });
  stepAppend(session, await listener({ agent: { session }, step: 1 }, async () => ({ messages: [peer] })));
  const firstPingSeq = nodes.find((node) => (events.get(node)?.data?.source?.kind === 'memory-cue'));
  assert.ok(firstPingSeq);
  stepAppend(session, await listener({ agent: { session }, step: 2 }, async () => ({ messages: [peer] })));
  const replacement = appended.find((entry) => entry.opts?.surfaceOp?.op === 'replace' && entry.opts.surfaceOp.startSeq === firstPingSeq);
  assert.ok(replacement, 'replace must target the old cue seq');
  assert.deepEqual(replacement.opts.sourceEventSeqs, [firstPingSeq], 'replace must carry sourceEventSeqs');
  assert.equal(events.get(firstPingSeq).data.source.kind, 'memory-cue-retired');
  const active = nodes.map((s) => events.get(s)).filter((event) => event?.data?.source?.kind === 'memory-cue' && event.data.content?.[0]?.text);
  assert.equal(active.length, 1);
  assert.ok(active[0].data.content[0].text.includes('generation-2'));
  assert.equal(active[0].data.content[0].text.includes('generation-1'), false);
});

test('H=0 clears the previous standing cue', async () => {
  const session = fakeSession();
  const { listener: withPing } = makePreStep({ session, answer: { enabled: true, H: 1, ping: { text: '[记忆共振] old' } } });
  stepAppend(session, await withPing({ agent: { session }, step: 1 }, async () => ({ messages: [peer] })));
  assert.equal(pingNodes(session).length, 1);
  const { listener: noPing } = makePreStep({ session, answer: { enabled: true, H: 0, ping: { text: '' } } });
  const decision = await noPing({ agent: { session }, step: 2 }, async () => ({ messages: [peer] }));
  assert.equal(decision.messages.length, 1);
  assert.equal(pingNodes(session).length, 0);
});

test('legacy turn-ping-memory is detected, warned, and never retired by production', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-cue-'));
  const debugPath = path.join(dir, 'debug.jsonl');
  const session = fakeSession();
  const legacy = session.append('user/message', { role: 'user', content: [{ type: 'text', text: '[记忆共振] legacy' }], source: { kind: 'turn-ping-memory' } }, { surfaceOp: 'append' });
  assert.equal(pingNodes(session).length, 0);
  const { listener } = makePreStep({ session, answer: { enabled: false, H: 0, ping: { text: '' } }, debugPath });
  await listener({ agent: { session }, step: 1 }, async () => ({ messages: [peer] }));
  assert.equal(session.eventAt(legacy.seq).data.message.source.kind, 'turn-ping-memory');
  const rows = fs.readFileSync(debugPath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const warning = rows.find((row) => row.kind === 'legacy-cue-detected');
  assert.ok(warning);
  assert.equal(warning.count, 1);
  assert.deepEqual(warning.seqs, [legacy.seq]);
  assert.equal(rows.some((row) => row.kind === 'ttl-error'), false);
});

test('memory-cue and legacy turn-ping-memory are excluded from sourceView, turn construction, and new query', async () => {
  const events = [
    { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: 'real user' } },
    { seq: 2, type: 'user/message', data: { source: { kind: 'memory-cue' }, content: '[记忆共振] should not be source' } },
    { seq: 3, type: 'user/message', data: { source: { kind: 'turn-ping-memory' }, content: '[记忆共振] legacy should not be source' } },
    { seq: 4, type: 'assistant/message', data: { content: 'answer' } },
  ];
  const view = buildSourceView(events, { sourceView: { userSourceKinds: ['user', 'peer'], userChars: 4000, assistantChars: 5000, toolChars: 1500, totalChars: 16000 } });
  assert.equal(view.text.includes('记忆共振'), false);
  const turns = buildTurnsFromEvents('s1', events);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].seqStart, 1);
  assert.equal(turnPingUserText([{ role: 'user', content: [{ type: 'text', text: '[记忆共振] new' }], source: { kind: 'memory-cue' } }]), '');
  assert.equal(turnPingUserText([{ role: 'user', content: [{ type: 'text', text: '[记忆共振] old' }], source: { kind: 'turn-ping-memory' } }]), '');
});

test('memory-cue and legacy turn-ping-memory never become fullseed boundaries or query text', () => {
  const events = [
    { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, message: { source: { kind: 'user' }, content: 'real user' } } },
    { seq: 2, type: 'user/message', data: { source: { kind: 'memory-cue' }, content: '[记忆共振] new cue' } },
    { seq: 3, type: 'user/message', data: { source: { kind: 'turn-ping-memory' }, content: '[记忆共振] old cue' } },
    { seq: 4, type: 'assistant/message', data: { content: 'answer' } },
  ];
  const chunks = buildRawChunks('s1', events, { checkpointSeq: 10 }).chunks;
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].rawText.includes('记忆共振'), false);
});
