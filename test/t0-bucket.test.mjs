import test from 'node:test';
import assert from 'node:assert/strict';
import { matchableTags, TAG_ZERO } from '../src/tags.mjs';

test('matchableTags：T0 永远不在匹配范围里', () => {
  const rows = [
    { id: 'T0', label: '未分类' },
    { id: 't-v2-t8', label: '跑团', keywords: ['跑团'] },
  ];
  const got = matchableTags(rows);
  assert.deepEqual(got.map((r) => r.id), ['t-v2-t8']);
});

test('matchableTags：T0 就算被塞了关键词也不参与匹配', () => {
  const rows = [
    { id: 'T0', label: '未分类', keywords: ['重启', '好'] },
    { id: 't-v2-t8', label: '跑团' },
  ];
  assert.equal(matchableTags(rows).some((r) => r.id === TAG_ZERO), false);
});

test('matchableTags：别名形式的 T0 也过滤', () => {
  const rows = [{ alias: 'T0', label: '未分类' }, { alias: 'T8', label: '跑团' }];
  assert.deepEqual(matchableTags(rows).map((r) => r.alias), ['T8']);
});
