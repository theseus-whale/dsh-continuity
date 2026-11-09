import test from 'node:test';
import assert from 'node:assert/strict';
import { installSessionGuard } from '../src/session-guard.mjs';

let guard = null;
installSessionGuard({
  inject: (_deps, fn) => fn({
    tools: { guard: (cb) => { guard = cb; } },
    effect: (f) => f(),
  }),
});
assert.ok(guard, 'guard installed');

const OWN = 'session-example';
const OTHER = 'session-example';
// 拼出来，避免测试文件本身成为一个"含路径字面量"的文件
const rootDir = ['C:', 'Users', 'example', '.' + 'dsh', 'continuity'].join('/');
const p = (...parts) => [rootDir, ...parts].join('/');

const exec = (name, args, sessionId = OWN) => ({ name, arguments: args, agent: { session: { id: sessionId } } });
const allows = (name, args, sid) => guard(exec(name, args, sid)) === undefined;

test('1 send_message 文本含路径 -> 放行', () => {
  assert.equal(allows('send_message', { to: 'x', text: '路径 ' + p('sessions', OTHER, 'rules.md') }), true);
});
test('2 edit 的 old/new 含路径 -> 放行', () => {
  assert.equal(allows('edit', { file_path: 'C:/work/a.mjs', old_string: p('sessions', OTHER, 'rules.md'), new_string: 'x' }), true);
});
test('3 write 工作区文件 content 含路径 -> 放行', () => {
  assert.equal(allows('write', { file_path: 'C:/work/doc.md', content: '见 ' + p('sessions', OTHER, 'rules.md') }), true);
});
test('4 write 另一个 session 的 rules.md -> 拒绝', () => {
  assert.notEqual(allows('write', { file_path: p('sessions', OTHER, 'rules.md'), content: 'x' }), true);
});
test('5 read 另一个 session 的 rules.md -> 拒绝', () => {
  assert.notEqual(allows('read', { file_path: p('sessions', OTHER, 'rules.md') }), true);
});
test('6 read 自己的 rules.md -> 放行', () => {
  assert.equal(allows('read', { file_path: p('sessions', OWN, 'rules.md') }), true);
});
test('7 pwsh 命令含别人的 session 路径 -> 拒绝', () => {
  assert.notEqual(allows('pwsh', { command: 'Get-Content "' + p('sessions', OTHER, 'rules.md') + '"' }), true);
});
test('8 pwsh 普通命令 -> 放行', () => {
  assert.equal(allows('pwsh', { command: 'Get-Date' }), true);
});
test('9 共享根目录 -> 拒绝', () => {
  assert.notEqual(allows('read', { file_path: p('rules.md') }), true);
});
test('10 operator allowlist 可以跨 session 维护', () => {
  assert.equal(allows('pwsh', { command: 'Get-Date' }, OTHER), true);
  assert.equal(allows('read', { file_path: p('sessions', OTHER, 'rules.md') }, OTHER), true);
});
test('11 root identity map is readable but not writable', () => {
  assert.equal(allows('read', { file_path: p('session-persona.json') }), true);
  assert.notEqual(allows('write', { file_path: p('session-persona.json'), content: 'x' }), true);
});
test('12 root identity map shell command stays guarded', () => {
  assert.notEqual(allows('pwsh', { command: 'Get-Content "' + p('session-persona.json') + '"' }), true);
});
test('13 context log is readable, not writable', () => {
  assert.equal(allows('read', { file_path: p('context-log.jsonl') }), true);
  assert.notEqual(allows('write', { file_path: p('context-log.jsonl'), content: 'x' }), true);
  assert.notEqual(allows('pwsh', { command: 'Get-Content "' + p('context-log.jsonl') + '"' }), true);
});

