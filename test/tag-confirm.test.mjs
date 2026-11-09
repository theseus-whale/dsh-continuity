import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findNearLabel,
  hasWordEvidence,
  splitNewToken,
  tagTokenFromDeclaration,
} from '../src/tag-confirm.mjs';

test('tagTokenFromDeclaration keeps ASCII hyphens', () => {
  assert.equal(tagTokenFromDeclaration('TAG: F-35 — 战机'), 'F-35');
  assert.equal(tagTokenFromDeclaration('TAG: COVID-19 — 疫情'), 'COVID-19');
  assert.equal(tagTokenFromDeclaration('TAG: T14 — 折叠边界'), 'T14');
});

test('only explicit NEW: is a new-tag request', () => {
  assert.equal(splitNewToken('NEW:F-35'), 'F-35');
  assert.equal(splitNewToken('NEW: 新话题'), '新话题');
  assert.equal(splitNewToken('NEW: "T6"'), 'T6');
  assert.equal(splitNewToken('F-35'), null);
  assert.equal(splitNewToken('asdfgh'), null);
});

test('hasWordEvidence rejects TAG-only and gate-only mentions', () => {
  assert.equal(hasWordEvidence({ userText: '聊聊 F-35', word: 'F-35' }), true);
  assert.equal(hasWordEvidence({ assistantText: 'F-35 的雷达', word: 'F-35' }), true);
  assert.equal(hasWordEvidence({ assistantText: 'TAG: F-35 — 战机', word: 'F-35' }), false);
  assert.equal(hasWordEvidence({ userText: '[闸·打标] 你写的是新词「F-35」', word: 'F-35' }), false);
});

test('findNearLabel catches one-character label typos', () => {
  const labels = [{ id: 't16', alias: 'T16', label: '绝地潜兵' }];
  assert.equal(findNearLabel(labels, '绝地潜冰')?.alias, 'T16');
  assert.equal(findNearLabel(labels, 'F-35'), null);
});
