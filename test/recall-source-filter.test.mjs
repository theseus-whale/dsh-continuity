import assert from 'node:assert/strict';
import test from 'node:test';
import { lastUserText } from '../src/memory/extraction-pre-step.mjs';

test('runtime-context user messages are not treated as human input', () => {
  const messages = [
    { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current runtime context: DeepSeek Harness' }] },
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '真正的用户输入' }] },
  ];
  assert.equal(lastUserText(messages), '真正的用户输入');
  assert.equal(lastUserText([messages[0]]), '');
});
