import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeRules, threadContextText } from '../src/threads.mjs';

test('pointer-only context keeps rules/habits pointers and drops line/tag', () => {
  const text = threadContextText('', summarizeRules('## A\n\n## B\n'), summarizeRules('## C\n'));
  assert.doesNotMatch(text, /\[工作线\]/);
  assert.doesNotMatch(text, /\[标签\]/);
  assert.match(text, /\[规则\]/);
  assert.match(text, /rules\.md/);
  assert.match(text, /\[习惯\]/);
  assert.match(text, /habits\.md/);
});
