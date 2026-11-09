import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { autoLearn } from '../src/training.mjs';

function tmpSkill() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-train-'));
  const file = path.join(dir, 'skill.md');
  fs.writeFileSync(file, ['# 技能', '', '## 失败分支', '', '- **已有教训**：x', '', '## 证据', '- 0', ''].join('\n'), 'utf8');
  return file;
}

test('首次自动写入，二次判重', () => {
  const f = tmpSkill();
  assert.equal(autoLearn({ sig: 'Error: something broke', count: 2, skillFile: f }).action, 'appended');
  assert.equal(autoLearn({ sig: 'Error: something broke', count: 5, skillFile: f }).action, 'duplicate');
  const txt = fs.readFileSync(f, 'utf8');
  assert.equal(txt.split('\n').filter((l) => l.includes('something broke')).length, 1);
});

test('写进失败分支段，不落到证据段', () => {
  const f = tmpSkill();
  autoLearn({ sig: 'TypeError: boom', count: 2, skillFile: f });
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  const bullet = lines.findIndex((l) => l.includes('TypeError: boom'));
  const evidence = lines.findIndex((l) => l.startsWith('## 证据'));
  assert.ok(bullet > 0 && bullet < evidence);
});

test('上限 12 条后拒绝并提示合并', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-train-'));
  const f = path.join(dir, 'skill.md');
  const bullets = Array.from({ length: 12 }, (_, i) => `- **教训 ${i}**：x`).join('\n');
  fs.writeFileSync(f, ['## 失败分支', '', bullets, '', '## 证据', ''].join('\n'), 'utf8');
  const res = autoLearn({ sig: 'Error: brand new', count: 2, skillFile: f });
  assert.equal(res.action, 'cap');
});
