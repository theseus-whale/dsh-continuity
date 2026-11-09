import test from 'node:test';
import assert from 'node:assert/strict';
import { planSplits, runsForThread, blocksByTag } from '../src/split-range.mjs';

const turns = [
  { turn: 1, seqs: [10, 12] },
  { turn: 2, seqs: [20, 22] },
  { turn: 3, seqs: [30] },
  { turn: 4, seqs: [40, 42] },
  { turn: 5, seqs: [50] },
];
const tagOf = new Map([[1, 't-a'], [2, 't-a'], [3, 't-b'], [4, 't-b'], [5, 't-b']]);

test('同标签连续两轮 → 一段', () => {
  const plan = planSplits({ turns: turns.slice(0, 2), tagOf });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].fromSeq, 10);
  assert.equal(plan[0].toSeq, 22);
});

test('标签变化 → 切成两段', () => {
  const plan = planSplits({ turns, tagOf });
  assert.equal(plan.length, 2);
  assert.deepEqual(plan.map((row) => row.tag), ['t-a', 't-b']);
  assert.equal(plan[0].toSeq, 22);
  assert.equal(plan[1].fromSeq, 30);
});

test('单轮小段并入前段（不会切碎）', () => {
  const plan = planSplits({ turns, tagOf: new Map([[1, 't-a'], [2, 't-b'], [3, 't-b'], [4, 't-b'], [5, 't-b']]) });
  assert.equal(plan.length, 1);
  // 单轮首段被并进后段：归属取后段的标签（多数轮在那边）
  assert.deepEqual(plan[0].tag, 't-b');
  assert.equal(plan[0].turns, 5);
});

test('T0 并入邻段', () => {
  const plan = planSplits({ turns, tagOf: new Map([[1, 't-a'], [2, 'T0'], [3, 't-a'], [4, 't-b'], [5, 't-b']]) });
  assert.deepEqual(plan.map((row) => row.tag), ['t-a', 't-b']);
});

test('限定区间只取区间内的 seq', () => {
  const plan = planSplits({ turns, tagOf, fromSeq: 25, toSeq: 45 });
  assert.equal(plan[0].fromSeq, 30);
  assert.equal(plan.at(-1).toSeq, 42);
});

// save 的机械分段：切到 T2 时只折 T4 的块，T2 的块原地留着。
const ev = (turn, seq) => ({ type: 'user/message', seq, data: { turn } });
const events = [ev(1, 10), ev(1, 12), ev(2, 20), ev(2, 22), ev(3, 30), ev(4, 40), ev(4, 42)];

test('切到 T2：T4 的块被折，T2 的块不被卷入', () => {
  const runs = runsForThread({ events, tagOf, fromSeq: 1, toSeq: 100, target: 't-a' });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].fromSeq, 10);
  assert.equal(runs[0].toSeq, 22);
  assert.equal(runs[0].turns, 2);
});

test('目标是尾巴上的 T2 → 只取尾巴那几轮', () => {
  const runs = runsForThread({ events, tagOf, fromSeq: 1, toSeq: 100, target: 't-b' });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].fromSeq, 30);
  assert.equal(runs[0].toSeq, 42);
  assert.equal(runs[0].turns, 2);
});

test('交错（T4 T2 T4）→ 目标有两个不连续块，各成一段', () => {
  const zigzag = new Map([[1, 't-a'], [2, 't-b'], [3, 't-a'], [4, 't-b']]);
  const runs = runsForThread({ events, tagOf: zigzag, fromSeq: 1, toSeq: 100, target: 't-a' });
  assert.equal(runs.length, 2);
  assert.equal(runs[0].toSeq, 12);
  assert.equal(runs[1].fromSeq, 30);
});

test('目标在这段里没有轮 → 返回空（不折）', () => {
  const runs = runsForThread({ events, tagOf, fromSeq: 1, toSeq: 100, target: 't-c' });
  assert.deepEqual(runs, []);
});

// load 切换前用 exclude：折「除目标外」的每个标签块。blocksByTag 是它的原料。
test('blocksByTag：按标签切成连续块，不合并、不筛选', () => {
  const tagOf2 = new Map([[1, 't-a'], [2, 't-a'], [3, 't-b'], [4, 't-c']]);
  const blocks = blocksByTag({ events, tagOf: tagOf2, fromSeq: 1, toSeq: 100 });
  assert.deepEqual(blocks.map((b) => b.tag), ['t-a', 't-b', 't-c']);
  assert.equal(blocks[0].fromSeq, 10);
  assert.equal(blocks[0].toSeq, 22);
  assert.equal(blocks[2].fromSeq, 40);
  assert.equal(blocks[2].toSeq, 42);
});

test('exclude t-b：剩下的块就是 t-a 与 t-c（t-b 原样留着）', () => {
  const tagOf2 = new Map([[1, 't-a'], [2, 't-a'], [3, 't-b'], [4, 't-c']]);
  const blocks = blocksByTag({ events, tagOf: tagOf2, fromSeq: 1, toSeq: 100 });
  const kept = blocks.filter((b) => b.tag !== 't-b');
  assert.deepEqual(kept.map((b) => b.tag), ['t-a', 't-c']);
  assert.equal(kept.length, 2);
});

// 回归（2026-10-30）：user/message 没有 data.turn，真实事件里用户原话会被漏掉，
// 折叠块从 assistant 开始 —— 用户原话永远折不进去，下一次 save 又看见它。
test('事件带 turn 字段（用户消息也可归轮）→ 块起点包含用户原话', () => {
  const mixed = [
    { type: 'user/message', seq: 5, turn: 1 },        // 没有 data.turn
    { type: 'assistant/message', seq: 10, data: { turn: 1 } },
    { type: 'user/message', seq: 15, turn: 2 },
    { type: 'assistant/message', seq: 22, data: { turn: 2 } },
  ];
  const runs = runsForThread({ events: mixed, tagOf: new Map([[1, 't-a'], [2, 't-a']]), fromSeq: 1, toSeq: 100, target: 't-a' });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].fromSeq, 5, '块必须从用户消息开始');
  assert.equal(runs[0].toSeq, 22);
});
