import test from 'node:test';
import assert from 'node:assert/strict';
import { untaggedTurnList } from '../src/t0.mjs';

const ev = (seq, turn, text = '内容') => ({
  type: 'user/message',
  seq,
  data: { turn, message: { content: [{ type: 'text', text }] } },
});

test('轮没标签 → 列出来（同一轮只列一次）', () => {
  const rows = untaggedTurnList({
    events: [ev(10, 1), ev(11, 1), ev(20, 2)],
    turnTagRows: [{ turn: 1, tag: 't-v2-t1' }],
  });
  assert.deepEqual(rows.map((r) => r.turn), [2]);
  assert.equal(rows[0].seq, 20);
});

test('全有标签 → 空', () => {
  const rows = untaggedTurnList({
    events: [ev(10, 1)],
    turnTagRows: [{ turn: 1, tag: 't-v2-t1' }],
  });
  assert.deepEqual(rows, []);
});

test('区间外的事件不算', () => {
  const rows = untaggedTurnList({
    events: [ev(10, 1), ev(99, 2)],
    turnTagRows: [],
    fromSeq: 50,
    toSeq: 60,
  });
  assert.deepEqual(rows, []);
});

test('非消息事件不参与', () => {
  const rows = untaggedTurnList({
    events: [{ type: 'step/start', seq: 10, data: { turn: 1 } }],
    turnTagRows: [],
  });
  assert.deepEqual(rows, []);
});
