import test from 'node:test';
import assert from 'node:assert/strict';
import { needsFullInjection, needsSkillInjection } from '../src/inject-policy.mjs';

const surface = (...seqs) => new Set(seqs);

test('规则：没有承载 seq → 注入（首轮）', () => {
  assert.equal(needsFullInjection({ text: 'rules', carrierSeq: undefined, surfaceSeqs: surface() }), true);
});

test('规则：承载 seq 还在 surface → 不注入', () => {
  assert.equal(needsFullInjection({ text: 'rules', carrierSeq: 10, surfaceSeqs: surface(1, 10, 11) }), false);
});

test('规则：承载 seq 被折叠掉 → 补注入（A 的核心判据）', () => {
  assert.equal(needsFullInjection({ text: 'rules', carrierSeq: 10, surfaceSeqs: surface(1, 11, 12) }), true);
});

test('规则：文本为空 → 永不注入', () => {
  assert.equal(needsFullInjection({ text: '', carrierSeq: undefined, surfaceSeqs: surface() }), false);
});

test('规则：内容变更 → 即使承载还在也强制补注入（rules 编辑生效）', () => {
  assert.equal(needsFullInjection({ text: 'rules v2', carrierSeq: 10, surfaceSeqs: surface(10), changed: true }), true);
});

test('技能：切换技能集 → 注入', () => {
  assert.equal(needsSkillInjection({ keyChanged: true, carrierSeq: 10, surfaceSeqs: surface(10) }), true);
});

test('技能：集没变且承载还在 → 不注入', () => {
  assert.equal(needsSkillInjection({ keyChanged: false, carrierSeq: 10, surfaceSeqs: surface(10) }), false);
});

test('技能：集没变但承载被折叠 → 不再补整份正文（只留 [技能] 一行）', () => {
  assert.equal(needsSkillInjection({ keyChanged: false, carrierSeq: 10, surfaceSeqs: surface(9) }), false);
});
