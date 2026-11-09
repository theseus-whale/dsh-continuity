import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPreflight } from '../src/preflight.mjs';

const ev = (seq, turn, type, text) => ({ seq, type, data: { turn, content: text === undefined ? [] : [{ type: 'text', text }] } });

test('区间内轮与标签统计', () => {
  const events = [
    ev(10, 1, 'user/message', '你好呀这是一句足够长的话'),
    ev(11, 1, 'assistant/message'),
    ev(12, 2, 'user/message', '另一句话'),
    ev(13, 2, 'assistant/message'),
  ];
  const rows = [{ turn: 1, tag: 't-a' }, { turn: 2, tag: 't-a' }];
  const r = buildPreflight({ events, turnTagRows: rows, fromSeq: 10, toSeq: 13 });
  assert.equal(r.turns, 2);
  assert.deepEqual(r.untaggedTurns, []);
  assert.equal(r.splitSuggested, false);
  assert.equal(r.tagCounts['t-a'], 4);
});

test('两个标签 → 建议拆段', () => {
  const events = [ev(10, 1, 'user/message', 'x'), ev(11, 2, 'user/message', 'y')];
  const rows = [{ turn: 1, tag: 't-a' }, { turn: 2, tag: 't-b' }];
  const r = buildPreflight({ events, turnTagRows: rows, fromSeq: 10, toSeq: 11 });
  assert.equal(r.splitSuggested, true);
  assert.equal(r.plan.length, 2);
  assert.equal(r.plan[0].tag, 't-a');
});

test('无标签且用户文本够长 → T0 候选', () => {
  const events = [ev(10, 1, 'user/message', '这是一句足够长的用户原话，应该被列为候选')];
  const r = buildPreflight({ events, turnTagRows: [], fromSeq: 10, toSeq: 10 });
  assert.deepEqual(r.untaggedTurns, [1]);
  assert.equal(r.t0Candidates.length, 1);
  assert.equal(r.t0Candidates[0].turn, 1);
});

test('区间外事件不参与', () => {
  const events = [ev(10, 1, 'user/message', 'in'), ev(20, 2, 'user/message', 'out')];
  const r = buildPreflight({ events, turnTagRows: [], fromSeq: 10, toSeq: 10 });
  assert.equal(r.turns, 1);
});
