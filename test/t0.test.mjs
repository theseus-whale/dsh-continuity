import test from 'node:test';
import assert from 'node:assert/strict';
import { contentUndecided, visibleText } from '../src/t0.mjs';

const userEv = (seq, text) => ({ type: 'user/message', seq, data: { message: { role: 'user', content: [{ type: 'text', text }] } } });
const asstEv = (seq, text, reasoning = '') => ({
  type: 'assistant/message',
  seq,
  data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: reasoning }, { type: 'text', text }] } },
});

const docWith = (memberships) => ({ tags: {}, runs: [], memberships });

test('visibleText：助手只取非 reasoning 部分', () => {
  assert.equal(visibleText(asstEv(1, '可见', '草稿')), '可见');
  assert.equal(visibleText(userEv(2, '用户说')), '用户说');
});

test('有标签的消息算已定', () => {
  const ev = [turnEv(1, 990, '一段话')];
  const doc = docWith({ 1: ['t-v2-t12'] });
  const r = contentUndecided({ events: ev, tagsDoc: doc });
  assert.equal(r.content, 1);
  assert.equal(r.tagged, 1);
  assert.deepEqual(r.undecided, []);
});

test('噪音与空 reasoning 不计入', () => {
  const ev = [userEv(1, '[线] 当前：x'), asstEv(2, '', '只有草稿')];
  const r = contentUndecided({ events: ev, tagsDoc: docWith({}) });
  assert.equal(r.content, 0);
});

test('未决会被列出来（带文本头）', () => {
  const ev = [turnEv(1, 990, '这是没有标签的一句话')];
  const r = contentUndecided({ events: ev, tagsDoc: docWith({}) });
  assert.equal(r.undecided.length, 1);
  assert.equal(r.undecided[0].seq, 1);
  assert.ok(r.undecided[0].head.includes('没有标签'));
});

test('显式 t0 决定算已定，不算未决', () => {
  const ev = [turnEv(1, 990, '已重启')];
  const r = contentUndecided({
    events: ev,
    tagsDoc: docWith({}),
    decisions: [{ seqs: [1], as: 't0' }],
  });
  assert.equal(r.t0Decided, 1);
  assert.deepEqual(r.undecided, []);
});

test('判给标签的决定也算已定（memberships 未落也能过闸）', () => {
  const ev = [turnEv(1, 990, '跑团的一句')];
  const r = contentUndecided({
    events: ev,
    tagsDoc: docWith({}),
    decisions: [{ seqs: [1], as: 'tag:T8' }],
  });
  assert.deepEqual(r.undecided, []);
});

test('区间边界生效', () => {
  const ev = [turnEv(1, 990, '早'), turnEv(5, 991, '晚')];
  const r = contentUndecided({ events: ev, tagsDoc: docWith({}), fromSeq: 3 });
  assert.equal(r.content, 1);
  assert.equal(r.undecided[0].seq, 5);
});

// 无轮号的消息**可以**有归属：归属来自 run/override（按 seq），不需要轮号。
// 2026-10-30 用户纠正：之前写「无轮号 → 跳过」等于把 37 条真实用户消息当成不用管。
test('无轮号且无覆盖 → 算未决，并单独计数 noTurn', () => {
  const r = contentUndecided({ events: [userEv(7, '没有轮号的一句话')], tagsDoc: docWith({}), turnTagRows: [] });
  assert.equal(r.undecided.length, 1);
  assert.equal(r.noTurn, 1);
  assert.equal(r.content, 1);
});

test('无轮号但被 override 覆盖 → 算已判', () => {
  const doc = { tags: {}, runs: [], memberships: {}, overrides: { 7: 't-v2-t4' } };
  const r = contentUndecided({ events: [userEv(7, '没有轮号但有归属')], tagsDoc: doc, turnTagRows: [] });
  assert.equal(r.undecided.length, 0);
  assert.equal(r.tagged, 1);
});

test('结构性消息（checkpoint / system-reminder）不算内容', () => {
  const ev = [
    userEv(20, 'This is an automatically generated checkpoint condensing an earlier span'),
    userEv(21, '<system-reminder> The available skill catalog changed. </system-reminder>'),
    userEv(22, '[放] 连续性哲学 · 第13/13段'),
  ];
  const r = contentUndecided({ events: ev, tagsDoc: docWith({}), turnTagRows: [] });
  assert.equal(r.content, 0);
  assert.equal(r.undecided.length, 0);
});

// 夹具不带 data.turn 时，旧代码走不到 taggedTurns 那一行，所以函数坏了测试还是绿的。
// 这两条故意带 turn：一条证明没标签的轮是未决，一条证明轮标签能放行。
const turnEv = (seq, turn, text) => ({ ...userEv(seq, text), data: { turn, message: { role: 'user', content: [{ type: 'text', text }] } } });

test('带轮号且轮没标签 → 未决，不抛 ReferenceError', () => {
  const r = contentUndecided({ events: [turnEv(10, 995, '这一轮没打标')], tagsDoc: docWith({}), turnTagRows: [] });
  assert.equal(r.undecided.length, 1);
  assert.equal(r.undecided[0].seq, 10);
});

test('带轮号且轮已打标 → 算已定', () => {
  const r = contentUndecided({
    events: [turnEv(10, 995, '这一轮打过标')],
    tagsDoc: docWith({}),
    turnTagRows: [{ turn: 995, tag: 'T4' }],
  });
  assert.deepEqual(r.undecided, []);
  assert.equal(r.tagged, 1);
});

test('机器注入与 peer 消息不计入 T0 未决', () => {
  const withSource = (seq, text, source) => ({
    type: 'user/message',
    seq,
    data: { source, message: { role: 'user', source, content: [{ type: 'text', text }] } },
  });
  const r = contentUndecided({
    events: [
      withSource(1, '[闸] TAG：', { kind: 'runtime-context', form: 'notice' }),
      withSource(2, 'Time sampled', { kind: 'time-context' }),
      withSource(3, '[创] peer', { kind: 'user' }),
      withSource(4, '真实用户', { kind: 'user' }),
      withSource(5, '[闸·打标] 错误', { kind: 'user' }),
    ],
    tagsDoc: docWith({}),
  });
  assert.equal(r.content, 1);
  assert.equal(r.undecided.length, 1);
  assert.equal(r.undecided[0].seq, 4);
});
