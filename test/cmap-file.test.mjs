import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCMapText } from '../src/memory/cmap-file.mjs';

test('C map parses old term => concepts with minB 0', () => {
  const text = '# C map\n跑团 => 游戏 / 故事 / 对话\n换箍 -> 技术 / 设备\n';
  assert.deepEqual(parseCMapText(text), [
    { term: '跑团', generic: ['游戏', '故事', '对话'], keywords: [], minB: 0, limit: 20, summary: '' },
    { term: '换箍', generic: ['技术', '设备'], keywords: [], minB: 0, limit: 20, summary: '' },
  ]);
});

test('C map parses new B/K/minB/summary', () => {
  const text = '跑团 => B:游戏/故事/剧情/对话 | K:Coopanion/Coo | minB:2 | 摘要：通过 Coopanion 和 Coo 进行的回合式剧情游戏 | 还有：这个 | 也算摘要\n';
  assert.deepEqual(parseCMapText(text), [{
    term: '跑团',
    generic: ['游戏', '故事', '剧情', '对话'],
    keywords: ['Coopanion', 'Coo'],
    minB: 2,
    limit: 20,
    summary: '通过 Coopanion 和 Coo 进行的回合式剧情游戏 | 还有：这个 | 也算摘要',
  }]);
});

test('unknown segments are ignored and bad lines are reported', () => {
  const errors = [];
  const text = '坏行没有箭头\n跑团 => B:游戏/故事 | K: | minB:2 | 摘要：x\n';
  const entries = parseCMapText(text, { onError: (error) => errors.push(error) });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].keywords.length, 0);
  assert.equal(entries[0].summary, 'x');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 1);
  assert.equal(errors[0].message, 'missing =>');
});
