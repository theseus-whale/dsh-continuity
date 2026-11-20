import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isRuleCueMessage, markRuleCueHistory, parseRuleBlocks, readRuleCueConfig, recentRuleCueIds, retiredRuleCueMessage,
  ruleCueMessage, scoreRuleBlocks, selectNovelRuleHits, stripRuleCueTransportEnvelope,
} from '../src/rule-cue.mjs';
import { installTurnPingPreStep } from '../src/turn-ping/pre-step.mjs';

const sample = `## 历史检索与回读
- 回答原话前，先回读原文。
  需要精确数字时也一样。
- 普通聊天不必检索。

## 沟通
- 按来信渠道回复。
`;

test('rule blocks keep section context and continuation lines', () => {
  const blocks = parseRuleBlocks(sample, 'R', '/tmp/rules.md');
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].id, 'R1.1');
  assert.match(blocks[0].vectorText, /历史检索与回读/);
  assert.match(blocks[0].text, /需要精确数字/);
  assert.equal(blocks[1].id, 'R1.2');
  assert.equal(blocks[2].id, 'R2.1');
});

test('Courier transport envelope is excluded only from Rule Cue matching text', () => {
  const wrapped = '[courier peer message from kimi-work/conv-test (Kimi)]\n晚安';
  assert.equal(stripRuleCueTransportEnvelope(wrapped), '晚安');
  assert.equal(stripRuleCueTransportEnvelope('普通用户消息'), '普通用户消息');
});

test('relevance and novelty select any number of distinct rules without a fixed cap', () => {
  const blocks = [
    { id: 'a', vector: [1, 0] },
    { id: 'b', vector: [0.99, 0.01] },
    { id: 'c', vector: [0, 1] },
    { id: 'd', vector: [-1, 0] },
  ];
  const { candidates } = scoreRuleBlocks(blocks, [1, 1], { tau: 0.5, delta: 0.06 });
  const selected = selectNovelRuleHits(candidates, []).map(row => row.id);
  assert.equal(selected.includes('a') || selected.includes('b'), true);
  assert.equal(selected.includes('a') && selected.includes('b'), false);
  assert.deepEqual(selected.filter(id => id === 'c'), ['c']);
  assert.deepEqual(selectNovelRuleHits(candidates, [{ vector: [1, 0] }]).map(row => row.id), ['c']);
});

test('0.56 absolute confidence gate suppresses a broad low-confidence candidate band', () => {
  const unit = score => [score, Math.sqrt(1 - score * score)];
  const blocks = [{ id: 'low-a', vector: unit(0.551) }, { id: 'low-b', vector: unit(0.538) }];
  const result = scoreRuleBlocks(blocks, [1, 0], readRuleCueConfig({}));
  assert.ok(Math.abs(result.top - 0.551) < 1e-12);
  assert.deepEqual(result.candidates, []);
});

test('rule cue history expires and config supports shadow/live/off with session opt-in', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-cue-history-'));
  const now = Date.now();
  markRuleCueHistory(root, ['R1.1'], now);
  assert.equal(recentRuleCueIds(root, now + 1000).has('R1.1'), true);
  assert.equal(recentRuleCueIds(root, now + 31 * 60_000).has('R1.1'), false);
  assert.equal(readRuleCueConfig({}).mode, 'shadow');
  assert.equal(readRuleCueConfig({}).tau, 0.56);
  assert.deepEqual(readRuleCueConfig({}).liveSessionIds, []);
  assert.equal(readRuleCueConfig({ ruleCue: { mode: 'off' } }).mode, 'off');
  const live = readRuleCueConfig({ ruleCue: { mode: 'live', liveSessionIds: ['continuity', 'continuity', 42] } });
  assert.equal(live.mode, 'live');
  assert.deepEqual(live.liveSessionIds, ['continuity']);
});

test('rule cue evaluator never writes the surface directly; lifecycle is handler-controlled', () => {
  const source = fs.readFileSync(new URL('../src/turn-ping/pre-step.mjs', import.meta.url), 'utf8');
  const method = source.slice(source.indexOf('const evaluateRuleCue'), source.indexOf('const runRuleCue'));
  assert.doesNotMatch(method, /session\.append|contextMessage\(/);
  assert.match(method, /full-carrier-present/);
  const engine = fs.readFileSync(new URL('../src/engine.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(engine, /evaluateRuleCue|rule-cue\.mjs/);
  assert.equal(ruleCueMessage([{ id: 'R1.1', section: '沟通', text: '- 先回读。' }]).source.kind, 'rule-cue');
  assert.equal(retiredRuleCueMessage().source.kind, 'rule-cue-retired');
});

test('pre-step uses the current decision text and runs before quiet-mode early return', async () => {
  const listeners = new Map();
  const ctx = { on: (name, fn) => listeners.set(name, fn) };
  const seen = [];
  let memoryCalls = 0;
  installTurnPingPreStep({
    ctx,
    config: { mode: 'opt-in', boundaries: { allowLiveInjection: true }, autoRecall: { mode: 'quiet' }, ruleCue: { mode: 'shadow' } },
    ruleCueTurn: async args => seen.push(args),
    beforeAnswer: async () => { memoryCalls += 1; return { enabled: false, H: 0, ping: { text: '' } }; },
    log: { warn() {} },
  });
  const session = { id: 'rule-cue-current', surface: { nodes: [1] }, eventAt: () => null, snapshotEvents: () => [] };
  const previous = { role: 'user', content: [{ type: 'text', text: '晚安' }], source: { kind: 'user' } };
  const current = { role: 'user', content: [{ type: 'text', text: '[courier peer message from kimi-work/conv-test (Kimi)]\n我要改程序了，先别重启' }], source: { kind: 'user' } };
  const decision = await listeners.get('agent/pre-step')({ agent: { session }, step: 1 }, async () => ({ messages: [previous, current] }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, '我要改程序了，先别重启');
  assert.equal(seen[0].sourceKind, 'user');
  assert.equal(memoryCalls, 0);
  assert.equal(decision.messages.length, 2);
});


function makeLiveRuleCueHarness({ sessionId = 'continuity', liveSessionIds = ['continuity'], selected = [] } = {}) {
  const listeners = new Map();
  const ctx = { on: (name, fn) => listeners.set(name, fn) };
  const seen = [];
  let result = { selected, liveInjection: selected.length > 0 };
  installTurnPingPreStep({
    ctx,
    config: {
      mode: 'opt-in', boundaries: { allowLiveInjection: true }, autoRecall: { mode: 'quiet' },
      ruleCue: { mode: 'live', liveSessionIds },
    },
    ruleCueTurn: async args => { seen.push(args); return result; },
    beforeAnswer: async () => { throw new Error('quiet early return must not retrieve memories'); },
    log: { warn() {} },
  });
  const nodes = [1];
  const events = new Map();
  let seq = 100;
  const session = {
    id: sessionId,
    surface: { nodes },
    eventAt: seq => events.get(seq) ?? null,
    snapshotEvents: () => [],
    append(type, message, opts = {}) {
      seq += 1;
      const event = { seq, type, data: { message } };
      if (opts.surfaceOp === 'append') nodes.push(seq);
      if (opts.surfaceOp?.op === 'replace') events.set(opts.surfaceOp.startSeq, event);
      events.set(seq, event);
      return event;
    },
  };
  const current = { role: 'user', content: [{ type: 'text', text: '我要改程序了，先别重启' }], source: { kind: 'user' } };
  return {
    session, seen,
    setResult(value) { result = value; },
    step: () => listeners.get('agent/pre-step')({ agent: { session }, step: 1 }, async () => ({ messages: [current] })),
    stepWith: messages => listeners.get('agent/pre-step')({ agent: { session }, step: 2 }, async () => ({ messages })),
  };
}

test('live Rule Cue appends only for an opted-in session and a nonempty selection', async () => {
  const selected = [{ id: 'R3.4', section: '修改与验证', text: '- 修改程序前先确认影响范围。' }];
  const harness = makeLiveRuleCueHarness({ selected });
  const decision = await harness.step();
  assert.equal(harness.seen[0].liveInjection, true);
  assert.equal(decision.messages.length, 2);
  const cue = decision.messages.at(-1);
  assert.equal(cue.source.kind, 'rule-cue');
  assert.match(cue.content[0].text, /规则提示·相关条目/);
  assert.match(cue.content[0].text, /R3\.4·修改与验证/);
  assert.match(cue.content[0].text, /修改程序前先确认影响范围/);
});

test('live mode without session opt-in cannot append even if a custom evaluator claims success', async () => {
  const selected = [{ id: 'R3.4', section: '修改与验证', text: '- 不应注入。' }];
  const harness = makeLiveRuleCueHarness({ sessionId: 'sonar', liveSessionIds: ['continuity'], selected });
  const decision = await harness.step();
  assert.equal(harness.seen[0].liveInjection, false);
  assert.equal(decision.messages.length, 1);
  assert.equal(decision.messages.some(isRuleCueMessage), false);
});

test('a no-hit turn retires the previous live Rule Cue instead of accumulating it', async () => {
  const selected = [{ id: 'H3.3', section: '修改与验证', text: '- 先备份再修改。' }];
  const harness = makeLiveRuleCueHarness({ selected });
  const first = await harness.step();
  const cue = first.messages.at(-1);
  harness.session.append('user/message', cue, { surfaceOp: 'append' });
  const activeSeq = harness.session.surface.nodes.at(-1);
  assert.equal(isRuleCueMessage(harness.session.eventAt(activeSeq).data.message), true);

  harness.setResult({ selected: [], liveInjection: false });
  const second = await harness.step();
  assert.equal(second.messages.length, 1);
  assert.equal(harness.session.eventAt(activeSeq).data.message.source.kind, 'rule-cue-retired');
  const active = harness.session.surface.nodes
    .map(seq => harness.session.eventAt(seq)?.data?.message)
    .filter(isRuleCueMessage);
  assert.deepEqual(active, []);
});


test('a tool follow-up without new user text preserves the active Rule Cue', async () => {
  const selected = [{ id: 'R3.4', section: '修改与验证', text: '- 工具步骤也要保留。' }];
  const harness = makeLiveRuleCueHarness({ selected });
  const first = await harness.step();
  harness.session.append('user/message', first.messages.at(-1), { surfaceOp: 'append' });
  const activeSeq = harness.session.surface.nodes.at(-1);
  const seenBefore = harness.seen.length;

  const followUp = await harness.stepWith([]);
  assert.equal(followUp.messages.length, 0);
  assert.equal(harness.seen.length, seenBefore, 'no new query means no new Rule Cue evaluation');
  assert.equal(isRuleCueMessage(harness.session.eventAt(activeSeq).data.message), true);
});
