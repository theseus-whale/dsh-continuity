import test from 'node:test';
import assert from 'node:assert/strict';
import { turnTagGap } from '../src/t0.mjs';

const msg = (seq, turn, type = 'assistant/message') => ({ type, seq, data: { turn } });

test('全局缺口：已结束的轮没标签 → 列出来', () => {
  const r = turnTagGap({
    events: [msg(10, 1), msg(20, 2), msg(30, 3), msg(40, 4)],
    turnTagRows: [{ turn: 1, tag: 't-v2-t1' }, { turn: 2, tag: 't-v2-t2' }],
    boundaryTurn: 3,
  });
  assert.equal(r.settled, 3);
  assert.equal(r.tagged, 2);
  assert.deepEqual(r.missing.map((row) => row.turn), [3]);
});

test('大缺口：当前 10 轮只标了 3 轮 → 缺口 6 轮（不含正在进行的那轮）', () => {
  const events = [];
  for (let turn = 1; turn <= 10; turn += 1) events.push(msg(turn * 10, turn));
  const rows = [1, 2, 3].map((turn) => ({ turn, tag: 't-v2-t1' }));
  const r = turnTagGap({ events, turnTagRows: rows, boundaryTurn: 9 });
  assert.equal(r.missing.length, 6);
  assert.equal(r.missing.at(-1).turn, 9);
});

test('有用户文本的缺口会被标记（补判时要读原文）', () => {
  const r = turnTagGap({
    events: [msg(10, 1, 'user/message'), msg(20, 2, 'assistant/message')],
    turnTagRows: [],
    boundaryTurn: 1,
  });
  assert.equal(r.missing.length, 1);
  assert.equal(r.missing[0].hasUserText, true);
});
