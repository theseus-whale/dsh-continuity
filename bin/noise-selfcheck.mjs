#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { needsSkillInjection } from '../src/inject-policy.mjs';
import { selectTopic } from '../src/topic.mjs';

const rows = [
  { id: 'a', alias: 'A', label: 'A', keywords: ['普通词'] },
  { id: 'b', alias: 'B', label: 'B', keywords: ['专名甲', '专名乙'] },
];
const generic = new Set(['普通词']);

// 泛词单独出现：静默。
assert.equal(selectTopic({ rows, text: '普通词', genericWords: generic, activeId: 'b' }).blocked, true);
// 两个非泛词：可提示。
assert.equal(selectTopic({ rows, text: '专名甲 专名乙', genericWords: generic, activeId: 'a' }).blocked, false);
// 一个专属词：可提示。
assert.equal(selectTopic({
  rows,
  text: '专名甲',
  genericWords: generic,
  wordStats: new Map([['专名甲', { precision: 0.6, hits: 6 }]]),
  activeId: 'a',
}).blocked, false);

// 技能正文只跟集合变化走；载体被折叠不再重灌整份正文。
assert.equal(needsSkillInjection({ keyChanged: true }), true);
assert.equal(needsSkillInjection({ keyChanged: false }), false);

// 静态断言：新标签和存提醒的阈值仍在源码里。
const engine = readFileSync(new URL('../src/engine.mjs', import.meta.url), 'utf8');
assert.match(engine, /snippet\.length >= 40/);
assert.match(engine, /cands\.length === 0 && snippet\.length >= 40/);
assert.match(engine, /currentTurn - Number\(last\?\.turn.*>= 20/);
assert.match(engine, /contentAfter >= 8 && gap >= 20/);
assert.match(engine, /this\.saveAsked/);
assert.match(engine, /TAG: <T 别名/);
assert.match(engine, /可选短语/);
assert.match(engine, /tagLearnShown/);
assert.match(engine, /turn-gate\.jsonl/);
assert.match(engine, /auditGate-failed/);
assert.match(engine, /habits\.md/);
assert.match(engine, /splitNewToken/);
assert.match(engine, /tagIdOf\(made\)/);
assert.match(engine, /gate-steer\.jsonl/);
assert.match(engine, /snapshotEvents/);
assert.match(engine, /bumpTagCount/);
assert.match(engine, /闸·线/);

console.log('noise-selfcheck PASS');
