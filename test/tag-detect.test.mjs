import test from 'node:test';
import assert from 'node:assert/strict';
import { findTagDeclaration, tagDeclarationCandidates } from '../src/tag-detect.mjs';

const body = (n) => Array.from({ length: n }, (_, i) => `正文第 ${i + 1} 行`).join('\n');

test('a TAG on the first line is a declaration even with a long body', () => {
  const text = 'TAG: T14 — 首行声明\n' + body(20);
  assert.equal(findTagDeclaration(text), 'TAG: T14 — 首行声明');
});

test('a TAG in the last five non-empty lines is still a declaration', () => {
  const text = body(20) + '\nTAG: T14 — 末行声明';
  assert.equal(findTagDeclaration(text), 'TAG: T14 — 末行声明');
});

test('last-five wins over the first line when both declare', () => {
  const text = 'TAG: FIRST — 首行\n' + body(20) + '\nTAG: LAST — 末行';
  assert.equal(findTagDeclaration(text), 'TAG: LAST — 末行');
});

test('TAG lines inside fenced blocks are not declarations', () => {
  const text = '```\nTAG: T14 — 示例\n```\n' + body(20);
  assert.equal(findTagDeclaration(text), null);
});

test('a fenced first line does not hide a later real declaration', () => {
  const text = '```\nTAG: T14 — 示例\n```\n\n正文\nTAG: T15 — 真声明';
  assert.equal(findTagDeclaration(text), 'TAG: T15 — 真声明');
});

test('candidates include head and tail without duplicating a short message', () => {
  assert.deepEqual(tagDeclarationCandidates('只有一行'), ['只有一行']);
  const rows = tagDeclarationCandidates('HEAD\n' + body(20) + '\nTAIL');
  assert.equal(rows[0], 'TAIL');
  assert.equal(rows.at(-1), 'HEAD');
});
