import test from 'node:test';
import assert from 'node:assert/strict';
import { signatureOf, note, topCandidates, scanResults, filterAnswered } from '../src/learning.mjs';

// 真失败回执由 harness 追加 [exit code: N]；构造输入时显式带上。
const fail = (t) => `${t}\n[exit code: 1]`;

test('签名归一：路径与数字被折叠', () => {
  const sig = signatureOf(fail('Error: ENOENT: no such file or directory, open C:\\temp\\a.json'));
  assert.ok(sig && sig.includes('<path>'), String(sig));
  const sig2 = signatureOf(fail('SyntaxError at line 42: unexpected token'));
  assert.ok(sig2 && sig2.includes('<n>'), String(sig2));
});

test('非错误文本或没有失败标记 → null', () => {
  assert.equal(signatureOf('SKIP=15 FAIL=0'), null);
  assert.equal(signatureOf(''), null);
  assert.equal(signatureOf('Error: PROBE is not a function'), null);
});

test('同签名累计，topCandidates 只取 >= min 的', () => {
  const map = new Map();
  note(map, 1, fail('TypeError: x is not a function'));
  note(map, 2, fail('TypeError: x is not a function'));
  note(map, 3, fail('SyntaxError: Unexpected token }'));
  const top = topCandidates(map, 2, 3);
  assert.equal(top.length, 1);
  assert.equal(top[0].count, 2);
  assert.equal(top[0].firstSeq, 1);
  assert.equal(top[0].lastSeq, 2);
});

test('不同签名互不合并', () => {
  const map = new Map();
  note(map, 1, fail('TypeError: a'));
  note(map, 2, fail('SyntaxError: b'));
  assert.equal(map.size, 2);
  assert.equal(topCandidates(map, 2).length, 0);
});

test('排除自报格式与统计行', () => {
  assert.equal(signatureOf(fail('  [5x] Unexpected token (seq 2038..19333)')), null);
  assert.equal(signatureOf(fail('[2x] SyntaxError: x')), null);
  assert.equal(signatureOf(fail('  2x Error: PROBE is not a function')), null);
  assert.ok(signatureOf(fail('SyntaxError: Unexpected identifier')) !== null);
});

test('正常退出但引用错误行 → 不学', () => {
  assert.equal(signatureOf('candidates=[{"sig":"Error: PROBE is not a function"}]'), null);
});

test('首次扫描看最新节点，而不是最旧的', () => {
  const events = [];
  for (let i = 1; i <= 10; i++) {
    events.push({ seq: i, type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'ok' }] } } });
  }
  events.push({ seq: 11, type: 'tool/result', data: { message: { content: [{ type: 'text', text: fail('TypeError: boom is not a function') }] } } });
  events.push({ seq: 12, type: 'tool/result', data: { message: { content: [{ type: 'text', text: fail('TypeError: boom is not a function') }] } } });
  const byseq = new Map(events.map((e) => [e.seq, e]));
  const map = new Map();
  const cursor = scanResults(map, { nodes: events.map((e) => e.seq), eventAt: (s) => byseq.get(s), cursor: 0, init: false, lookback: 2 });
  assert.equal(cursor, 12);
  assert.equal(topCandidates(map, 2).length, 1);
});

test('firstSeq/lastSeq 按数值取 min/max（扫描从新到旧）', () => {
  const map = new Map();
  note(map, 9, fail('TypeError: z'));
  note(map, 3, fail('TypeError: z'));
  const [c] = topCandidates(map, 2);
  assert.equal(c.firstSeq, 3);
  assert.equal(c.lastSeq, 9);
});

test('已答过的候选被过滤（前缀也算）', () => {
  const cands = [{ sig: 'TypeError: PROBE_lmnqrstv is not a function', count: 2 }];
  assert.equal(filterAnswered(cands, new Set(['TypeError: PROBE_lmnqrstv'])).length, 0);
  assert.equal(filterAnswered(cands, new Set(['TypeError: other'])).length, 1);
});