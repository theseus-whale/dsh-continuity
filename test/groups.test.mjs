import test from 'node:test';
import assert from 'node:assert/strict';
import { detectGroups, expandGroup, nameFromEvidence } from '../src/groups.mjs';

test('关键词重叠 ≥0.5 提议归拢', () => {
  const tags = { tags: {
    T200: { keywords: ['工程学', '有限元', '网格'] },
    T201: { keywords: ['工程学', '有限元'] },
    T202: { keywords: ['动力学'] },
  } };
  const got = detectGroups(tags, []);
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].members, ['T200', 'T201']);
  assert.equal(got[0].name, '工程学');
});

test('关键词不重叠不提议（T3a-e 反例）', () => {
  const tags = { tags: {
    T3a: { keywords: ['压缩', '读侧'] },
    T3b: { keywords: ['移植', '阶段'] },
    T3c: { keywords: ['预览层', '标题'] },
  } };
  assert.equal(detectGroups(tags, []).length, 0);
});

test('查询歧义：同一对命中 ≥2 次才提议，父名取查询原话', () => {
  const tags = { tags: { T9: { keywords: ['游戏'] }, T10: { keywords: ['手机'] } } };
  const lines = [
    JSON.stringify({ conclusion: 'multi:T9,T10', head: '小米和游戏本怎么选' }),
    JSON.stringify({ conclusion: 'multi:T10,T9', head: '手机性价比' }),
  ];
  const got = detectGroups(tags, lines);
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'query-ambiguity');
  assert.deepEqual([...got[0].members].sort(), ['T10', 'T9']);
});

test('只命中一次不提议', () => {
  const tags = { tags: {} };
  const lines = [JSON.stringify({ conclusion: 'multi:A,B', head: 'x' })];
  assert.equal(detectGroups(tags, lines).length, 0);
});


test('组名可递归展开，嵌套组也能展开', () => {
  const groups = {
    '工程学': { members: ['T200', 'T201'] },
    '理工科': { members: ['工程学', 'T300'] },
  };
  const ids = expandGroup(groups, '理工科');
  assert.deepEqual([...ids].sort(), ['T200', 'T201', 'T300']);
});

test('环引用抛错', () => {
  const groups = { A: { members: ['B'] }, B: { members: ['A'] } };
  assert.throws(() => expandGroup(groups, 'A'), /循环引用/);
});

test('未知组抛错', () => {
  assert.throws(() => expandGroup({}, 'nope'), /未知组/);
});


test('父名只取真词：有共同上位词就提炼出来', () => {
  const heads = ['设备选购：手机性价比和绝地潜兵怎么选', '设备选购再看手机性价比与绝地潜兵'];
  const kws = ['手机', '性价比', '绝地潜兵'];
  if (nameFromEvidence(heads, kws, kws) !== '设备选购') throw new Error('expected 设备选购');
});

test('父名不取碎片：关键词的碎片一律不要', () => {
  const heads = [
    '手机性价比之外，我还在打绝地潜兵2，想比较小米和游戏本的取舍',
    '手机性价比和绝地潜兵哪个更值得肝',
  ];
  const kws = ['手机', '性价比', '绝地潜兵', 'Helldivers', '小米', '游戏本'];
  const name = nameFromEvidence(heads, kws, kws);
  if (name !== '') throw new Error('expected empty, got ' + name);
});

test('证据不足（只出现一次）不给父名', () => {
  const name = nameFromEvidence(['只有一句话'], ['手机'], ['性价比']);
  if (name !== '') throw new Error('expected empty, got ' + name);
});
