import test from 'node:test';
import assert from 'node:assert/strict';
import { skillsForKeywords } from '../src/skills.mjs';

const index = {
  skills: [
    { name: 'change-loop', file: 'change-loop.md' },
    { name: 'backup-verify', file: 'backup-verify.md' },
    { name: 'patch-port', file: 'patch-port.md' },
  ],
  byKeyword: {
    '改动': 'change-loop.md',
    '重启': 'change-loop.md',
    '备份': 'backup-verify.md',
    '补丁': 'patch-port.md',
  },
};

test('keyword hit selects skill', () => {
  const got = skillsForKeywords(index, '先改完再重启，注意备份');
  assert.deepEqual(got.map((s) => s.name), ['change-loop', 'backup-verify']);
});

test('no keyword -> no skills', () => {
  assert.deepEqual(skillsForKeywords(index, '今天天气不错').map((s) => s.name), []);
});

test('duplicate keyword maps to one entry', () => {
  const got = skillsForKeywords(index, '改动之后重启');
  assert.deepEqual(got.map((s) => s.name), ['change-loop']);
});

test('unknown file in byKeyword is ignored', () => {
  const got = skillsForKeywords({ skills: index.skills, byKeyword: { 幽灵: 'ghost.md' } }, '幽灵出现');
  assert.deepEqual(got, []);
});
