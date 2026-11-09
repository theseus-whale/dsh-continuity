import assert from 'node:assert/strict';
import test from 'node:test';
import { detectRecallCue, shouldTriggerRecall } from '../src/memory/recall-cue.mjs';

test('high-precision cues trigger', () => {
  for (const text of [
    '上次那个跑团后来怎么样了',
    '之前我们说的灯塔还记得吗',
    '还记得那把钥匙吗',
    '回到刚才那段',
    '接着上次说',
    '那个项目现在怎样',
  ]) {
    assert.equal(shouldTriggerRecall(text), true, text);
  }
});

test('bare common words do not trigger', () => {
  for (const text of ['之前', '那个', '继续', '然后呢', '今天天气不错']) {
    assert.equal(shouldTriggerRecall(text), false, text);
  }
});

test('quoted cue words do not trigger', () => {
  assert.equal(shouldTriggerRecall('如果我说“上次”这个词，会触发吗？'), false);
  assert.equal(shouldTriggerRecall('`上次` 只是一个例子'), false);
});

test('detect returns the matched cue', () => {
  const result = detectRecallCue('上次我们聊到灯塔');
  assert.equal(result.hit, true);
  assert.equal(result.cue, '上次');
});
