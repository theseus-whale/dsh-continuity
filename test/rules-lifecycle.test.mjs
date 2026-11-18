import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planRulesLifecycle,
  readRulesCarrierSignature,
  rulesCarrierMetadata,
  rulesCarrierSignature,
} from '../src/rules-lifecycle.mjs';

const signature = rulesCarrierSignature('stable rules', 'stable habits');
const carrier = (seq = 42, value = signature) => ({
  seq,
  event: { data: { source: { kind: 'runtime-context', continuityRules: rulesCarrierMetadata(value) } } },
});

/** Production-shaped surface: replace removes the old node and installs the new event seq. */
function fakeSurface() {
  let seq = 100;
  const nodes = [];
  const events = new Map();
  const api = {
    nodes,
    eventAt: (s) => events.get(s) ?? null,
    append(type, message, opts = {}) {
      seq += 1;
      const event = { seq, type, data: message, surfaceOp: opts.surfaceOp };
      if (opts.surfaceOp === undefined || opts.surfaceOp === 'append') nodes.push(seq);
      else if (opts.surfaceOp?.op === 'replace') {
        const index = nodes.indexOf(opts.surfaceOp.startSeq);
        if (index < 0) throw new Error('surface replace: start seq not found');
        nodes.splice(index, 1, seq);
      }
      events.set(seq, event);
      return event;
    },
    messages: () => nodes.map((node) => events.get(node)),
  };
  return api;
}

test('three unchanged turns keep one full carrier', () => {
  const surface = fakeSurface();
  const first = surface.append('user/message', { text: 'full', source: { continuityRules: rulesCarrierMetadata(signature) } });
  for (let i = 0; i < 3; i += 1) {
    const plan = planRulesLifecycle({ hasContent: true, signature, carrier: { seq: first.seq, event: first }, surfaceSeqs: surface.nodes });
    assert.equal(plan.action, 'none');
  }
  assert.equal(surface.messages().length, 1);
});

test('restart uses persisted metadata rather than a process-local cache', () => {
  const persisted = carrier(42);
  assert.equal(readRulesCarrierSignature(persisted.event), signature);
  assert.equal(planRulesLifecycle({ hasContent: true, signature, carrier: persisted, surfaceSeqs: [42] }).action, 'none');
});

test('changed content replaces atomically and old full text leaves provider messages', () => {
  const surface = fakeSurface();
  const old = surface.append('user/message', { text: 'old full', source: { continuityRules: rulesCarrierMetadata(signature) } });
  const next = rulesCarrierSignature('new rules', 'stable habits');
  const plan = planRulesLifecycle({ hasContent: true, signature: next, carrier: { seq: old.seq, event: old }, surfaceSeqs: surface.nodes });
  assert.equal(plan.action, 'replace');
  assert.equal(plan.seq, old.seq);
  const replacement = surface.append('user/message', { text: 'new full', source: { continuityRules: rulesCarrierMetadata(next) } }, {
    surfaceOp: { op: 'replace', startSeq: plan.seq, endSeq: plan.seq },
    sourceEventSeqs: [plan.seq],
  });
  assert.equal(replacement.seq, 102);
  assert.deepEqual(surface.messages().map((event) => event.data.text), ['new full']);
});

test('folded carrier is appended when content exists', () => {
  assert.equal(planRulesLifecycle({ hasContent: true, signature, carrier: carrier(42), surfaceSeqs: [] }).action, 'append');
});

test('empty rules and habits replace and clear the old full carrier', () => {
  const empty = rulesCarrierSignature('', '');
  assert.deepEqual(planRulesLifecycle({ hasContent: false, signature: empty, carrier: carrier(42), surfaceSeqs: [42] }), {
    action: 'replace', reason: 'content-changed', seq: 42,
  });
  assert.equal(planRulesLifecycle({ hasContent: false, signature: empty, surfaceSeqs: [] }).action, 'none');
});

test('legacy carrier without metadata is replaced once and carries a new signature', () => {
  const legacy = { seq: 42, event: { data: { source: { kind: 'runtime-context' } } } };
  assert.equal(planRulesLifecycle({ hasContent: true, signature, carrier: legacy, surfaceSeqs: [42] }).reason, 'legacy-or-missing-signature');
});

test('production direct-data shape reads the signature', () => {
  const direct = { seq: 42, event: { data: { source: { continuityRules: rulesCarrierMetadata(signature) } } } };
  assert.equal(planRulesLifecycle({ hasContent: true, signature, carrier: direct, surfaceSeqs: [42] }).action, 'none');
});

test('failed replacement does not claim a successful state', () => {
  const surface = fakeSurface();
  const old = surface.append('user/message', { text: 'old', source: { continuityRules: rulesCarrierMetadata(signature) } });
  assert.throws(() => surface.append('user/message', { text: 'new' }, {
    surfaceOp: { op: 'replace', startSeq: 999, endSeq: 999 },
    sourceEventSeqs: [999],
  }), /not found/);
  assert.deepEqual(surface.messages().map((event) => event.data.text), ['old']);
  assert.equal(old.seq, 101);
});
