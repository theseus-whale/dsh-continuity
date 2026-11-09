import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTopic } from '../src/topic.mjs';

const rows = [
  { id: 't-a', alias: 'A', label: '旧话题', keywords: ['重启'] },
  { id: 't-b', alias: 'B', label: '跑团', keywords: ['跑团', '宁瓦尔', '矿洞'] },
  { id: 't-c', alias: 'C', label: 'Coo 改造', keywords: ['Coo', '重启'] },
];
const generic = new Set(['重启', 'Coo']);

test('只有泛词命中 → 不提示（重启不算证据）', () => {
  const r = selectTopic({ rows, text: '重启了，看看结果', genericWords: generic, activeId: 't-b' });
  assert.equal(r.blocked, true);
  assert.equal(r.reason, 'only-generic');
});

test('强词命中且不同线 → 提示切换', () => {
  const r = selectTopic({ rows, text: '我想聊跑团，宁瓦尔进矿洞', genericWords: generic, activeId: 't-c' });
  assert.equal(r.blocked, false);
  assert.equal(r.top.id, 't-b');
  assert.ok(r.top.strong.includes('跑团'));
});

test('强词在本线 → 不提示（已经在这条线）', () => {
  const r = selectTopic({ rows, text: '跑团继续，宁瓦尔往前走', genericWords: generic, activeId: 't-b' });
  assert.equal(r.blocked, true);
  assert.equal(r.reason, 'already-active');
});

test('只有一个非泛词、没有专属词 → 静默（不再靠单字 Coo 猜）', () => {
  const r = selectTopic({ rows, text: 'Coo 又重启了，继续改 Coo', genericWords: generic, activeId: 't-b' });
  assert.equal(r.blocked, true);
  assert.ok(['only-generic', 'weak-evidence'].includes(r.reason));
});

test('两个非泛词 → 可以提示', () => {
  const r = selectTopic({ rows, text: '跑团和矿洞都继续', genericWords: generic, activeId: 't-c' });
  assert.equal(r.blocked, false);
  assert.equal(r.top.id, 't-b');
});

test('专属词（precision>=0.5, hits>=5）一个就够', () => {
  const rows2 = [
    ...rows,
    { id: 't-d', alias: 'D', label: '专线', keywords: ['专属X'] },
  ];
  const r = selectTopic({
    rows: rows2,
    text: '这条专属X 继续',
    genericWords: generic,
    wordStats: new Map([['专属X', { precision: 0.6, hits: 6 }]]),
    activeId: 't-b',
  });
  assert.equal(r.blocked, false);
  assert.equal(r.top.id, 't-d');
  assert.ok(r.top.exclusive.includes('专属X'));
});

test('泛词即使被列为 anchor，也不得升格为强证据', () => {
  const rows2 = [
    ...rows,
    { id: 't-e', alias: 'E', label: '泛锚', keywords: ['Coo'], anchors: ['Coo'] },
  ];
  const r = selectTopic({
    rows: rows2,
    text: 'Coo',
    genericWords: generic,
    activeId: 't-b',
  });
  assert.equal(r.blocked, true);
  assert.ok(['only-generic', 'weak-evidence'].includes(r.reason));
});

test('无命中 → 不提示', () => {
  const r = selectTopic({ rows, text: '今天天气不错', genericWords: generic, activeId: 't-b' });
  assert.equal(r.blocked, true);
  assert.equal(r.reason, 'no-match');
});
