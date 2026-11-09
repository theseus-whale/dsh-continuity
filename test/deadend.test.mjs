import test from 'node:test';
import assert from 'node:assert/strict';
import { detectDeadEnds, pathFromArguments } from '../src/deadend.mjs';

test('pathFromArguments：edit/write 取 file_path', () => {
  assert.equal(pathFromArguments('edit', JSON.stringify({ file_path: 'a/b.mjs', old_string: 'x' })), 'a/b.mjs');
  assert.equal(pathFromArguments('write', JSON.stringify({ file_path: 'c/d.md' })), 'c/d.md');
  assert.equal(pathFromArguments('pwsh', JSON.stringify({ command: 'ls' })), null);
  assert.equal(pathFromArguments('edit', 'not json "file_path":"e/f.mjs"'), 'e/f.mjs');
});

test('同处改三版：同一路径 3 轮内被改 → 报警', () => {
  const calls = [10, 11, 12].map((turn) => ({ turn, path: 'src/engine.mjs' }));
  const r = detectDeadEnds({ toolCalls: calls, replies: [], windowTurns: 8 });
  assert.equal(r.sameSpot.length, 1);
  assert.equal(r.sameSpot[0].path, 'src/engine.mjs');
  assert.ok(r.symptoms.some((s) => s.includes('同处改多版')));
});

test('只改 2 轮 → 不报警', () => {
  const calls = [10, 11].map((turn) => ({ turn, path: 'a.mjs' }));
  const r = detectDeadEnds({ toolCalls: calls, replies: [], windowTurns: 8 });
  assert.equal(r.sameSpot.length, 0);
});

test('改完仍同错：同一签名在改动轮出现 2 次 → 报警', () => {
  const calls = [{ turn: 10, path: 'a.mjs' }, { turn: 11, path: 'a.mjs' }];
  const errors = [{ turn: 10, sig: 'TypeError: x' }, { turn: 11, sig: 'TypeError: x' }];
  const r = detectDeadEnds({ toolCalls: calls, errors, replies: [], windowTurns: 8 });
  assert.equal(r.fixLoop.length, 1);
  assert.equal(r.fixLoop[0].sig, 'TypeError: x');
});

test('说不清改完怎样：真动手改且没判据 → 提示', () => {
  const r = detectDeadEnds({
    toolCalls: [{ turn: 5, path: 'a.mjs' }],
    replies: [{ turn: 5, text: '我把这段改一下，应该就好了' }],
  });
  assert.equal(r.noCriteria, true);
  assert.ok(r.symptoms.some((s) => s.includes('缺验收标准')));
});

test('改且有判据 → 不提示', () => {
  const r = detectDeadEnds({
    toolCalls: [{ turn: 5, path: 'a.mjs' }],
    replies: [{ turn: 5, text: '我改一下；判据是测试全过、退出码 0' }],
  });
  assert.equal(r.noCriteria, false);
});

test('只讨论、没动手改 → 不提示（讲哲学被误报的回归测试）', () => {
  const r = detectDeadEnds({
    toolCalls: [],
    replies: [{ turn: 5, text: '这个说法会改变我们对连续性的理解' }],
  });
  assert.equal(r.noCriteria, false);
  assert.deepEqual(r.symptoms, []);
});
