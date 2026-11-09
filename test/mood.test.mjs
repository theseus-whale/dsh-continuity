import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMood, parseMoodLog, selectMood, shouldRecord } from '../src/mood.mjs';

test('extractMood：命中情绪词并给出原句，不给分数', () => {
  const r = extractMood('这一步又挂了。心里很烦，但先把日志看完。');
  assert.ok(r.markers.includes('很烦'));
  assert.equal(r.markers.length, 1);
  assert.equal(r.excerpt.includes('烦'), true); // excerpt = 第一句命中句
  assert.equal('score' in r, false); // 明确：没有自评强度
});

test('extractMood：中性文本不产生条目', () => {
  const r = extractMood('函数返回 3，测试通过。');
  assert.deepEqual(r.markers, []);
  assert.equal(r.excerpt, '');
});

test('parseMoodLog：mood / injected / cited 三种事件合并', () => {
  const lines = [
    JSON.stringify({ type: 'mood', seq: 10, at: '2026-10-29T00:00:00Z', excerpt: '烦', markers: ['烦'] }),
    JSON.stringify({ type: 'injected', seq: 10, at: '2026-10-29T01:00:00Z' }),
    JSON.stringify({ type: 'mood', seq: 11, at: '2026-10-29T00:30:00Z', excerpt: '累', markers: ['累'] }),
    JSON.stringify({ type: 'cited', seq: 11, at: '2026-10-29T02:00:00Z' }),
  ];
  const rows = parseMoodLog(lines);
  const bySeq = new Map(rows.map((r) => [r.seq, r]));
  assert.equal(bySeq.get(10).lastInjectedAt, '2026-10-29T01:00:00Z');
  assert.equal(bySeq.get(11).cited, true);
});

test('selectMood：冷却期内不重复注入', () => {
  const nowMs = Date.parse('2026-10-29T12:00:00Z');
  const entries = parseMoodLog([
    JSON.stringify({ type: 'mood', seq: 1, at: '2026-10-29T08:00:00Z', excerpt: 'a' }),
    JSON.stringify({ type: 'injected', seq: 1, at: '2026-10-29T11:00:00Z' }),
    JSON.stringify({ type: 'mood', seq: 2, at: '2026-10-29T08:30:00Z', excerpt: 'b' }),
  ]);
  const picked = selectMood(entries, { nowMs, cooldownHours: 6 });
  assert.deepEqual(picked.map((p) => p.seq), [2]);
});

test('selectMood：已提升为判据的条目不参与表达层注入', () => {
  const nowMs = Date.parse('2026-10-29T12:00:00Z');
  const entries = parseMoodLog([
    JSON.stringify({ type: 'mood', seq: 3, at: '2026-10-29T08:00:00Z', excerpt: 'c' }),
    JSON.stringify({ type: 'cited', seq: 3, at: '2026-10-29T09:00:00Z' }),
    JSON.stringify({ type: 'mood', seq: 4, at: '2026-10-29T08:00:00Z', excerpt: 'd' }),
  ]);
  const picked = selectMood(entries, { nowMs });
  assert.deepEqual(picked.map((p) => p.seq), [4]);
});

test('selectMood：超过 7 天没被碰的条目不注入，但记录仍在', () => {
  const nowMs = Date.parse('2026-10-29T12:00:00Z');
  const old = JSON.stringify({ type: 'mood', seq: 5, at: '2026-10-01T00:00:00Z', excerpt: 'e' });
  const entries = parseMoodLog([old]);
  assert.equal(entries.length, 1); // 记录保留
  assert.deepEqual(selectMood(entries, { nowMs }), []); // 不注入
});

test('selectMood：按“最久没注入”排序，不受引用次数影响（防自锁）', () => {
  const nowMs = Date.parse('2026-10-29T12:00:00Z');
  const entries = parseMoodLog([
    JSON.stringify({ type: 'mood', seq: 6, at: '2026-10-29T08:00:00Z', excerpt: 'f' }),
    JSON.stringify({ type: 'injected', seq: 6, at: '2026-10-29T09:00:00Z' }),
    JSON.stringify({ type: 'mood', seq: 7, at: '2026-10-29T10:00:00Z', excerpt: 'g' }),
  ]);
  // 7 从没注入过，优先；即使 6 被引用更多次，也不改变顺序
  const picked = selectMood(entries, { nowMs, cooldownHours: 1 });
  assert.deepEqual(picked.map((p) => p.seq), [7, 6]);
});


test('工程词不误报：压缩/累积/崩溃/困境/沉默', () => {
  const r = extractMood('压缩上下文后累积误差上升，崩溃排查进入困境，现场一片沉默。');
  assert.deepEqual(r.markers, []);
});

test('讨论 mood 本身的句子不算情绪（防自指刷屏）', () => {
  const r = extractMood('这条 mood 的 markers 是 lexicon 里的“难受”，要标记为待验证。');
  assert.deepEqual(r.markers, []);
});


test('质量闸：单标记 + 无第一人称 → 不收（防碎片）', () => {
  assert.equal(shouldRecord({ markers: ['轻松'], excerpt: '轻 (轻松/轻量), 松 (松散)' }), false);
});

test('质量闸：单标记 + 第一人称 → 收', () => {
  assert.equal(shouldRecord({ markers: ['很烦'], excerpt: '我心里很烦，但先把日志看完' }), true);
});

test('质量闸：两个标记 → 收，即使没有第一人称', () => {
  assert.equal(shouldRecord({ markers: ['很烦', '撑不住'], excerpt: '很烦，撑不住了' }), true);
});

test('parseMoodLog 保留 origin（谁写的、什么时候、因什么）', () => {
  const rows = parseMoodLog([JSON.stringify({
    type: 'mood', seq: 20, at: '2026-10-29T05:00:00Z', excerpt: '心里很烦', markers: ['很烦'],
    origin: { kind: 'reasoning', by: 'self', markers: ['很烦'] },
  })]);
  assert.equal(rows[0].origin.by, 'self');
  assert.equal(rows[0].origin.kind, 'reasoning');
});
