import assert from 'node:assert/strict';
import test from 'node:test';
import { detectSequence, detectShift, detectWindowShift, jaccard, shouldTrigger, shiftState } from '../src/memory/bc-shift.mjs';

test('jaccard handles empty and overlapping sets', () => {
  assert.equal(jaccard([], []), 1);
  assert.equal(jaccard(['a', 'b'], ['b', 'c']), 1 / 3);
});

test('same topic remains same', () => {
  const previous = { turn: 1, generic: ['游戏', '故事'], keywords: ['钥匙', '灯塔', '船'] };
  const current = { turn: 2, generic: ['游戏', '故事'], keywords: ['钥匙', '灯塔', '船'] };
  const shift = detectShift(previous, current);
  assert.equal(shift.kind, 'same');
});

test('topic switch triggers', () => {
  const previous = { turn: 1, generic: ['技术'], keywords: ['代码', '函数'] };
  const current = { turn: 2, generic: ['病毒'], keywords: ['COVID-19', '实验室泄漏'] };
  const shift = detectShift(previous, current);
  assert.equal(shift.kind, 'shift');
  assert.equal(shouldTrigger({ previous, current }).trigger, true);
});

test('explicit recall cue triggers even without a shift', () => {
  const previous = { turn: 1, generic: ['游戏'], keywords: ['钥匙'] };
  const current = { turn: 2, generic: ['游戏'], keywords: ['钥匙'] };
  assert.equal(detectShift(previous, current).kind, 'same');
  assert.equal(shouldTrigger({ previous, current, cue: true }).trigger, true);
});

test('shiftState normalizes a record', () => {
  const state = shiftState({ turn: 9, generic: ['游戏'], keywords: ['钥匙'], terms: ['跑团'] });
  assert.deepEqual(state, { turn: 9, generic: ['游戏'], keywords: ['钥匙'], terms: ['跑团'] });
});

test('window shift smooths a single odd turn', () => {
  const records = [
    { turn: 1, generic: ['游戏'], keywords: ['钥匙', '灯塔'] },
    { turn: 2, generic: ['游戏'], keywords: ['钥匙', '灯塔'] },
    { turn: 3, generic: ['设备'], keywords: ['锁'] },
    { turn: 4, generic: ['游戏'], keywords: ['钥匙', '灯塔'] },
    { turn: 5, generic: ['游戏'], keywords: ['钥匙', '灯塔'] },
  ];
  const boundary = detectWindowShift(records, 2, { window: 2, threshold: 0.5 });
  assert.notEqual(boundary.kind, 'shift');
  const sequence = detectSequence(records, { window: 2, threshold: 0.5 });
  assert.equal(sequence.length, 0);
});
