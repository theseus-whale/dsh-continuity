import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { REPAIR_PROMPT, normalizeL } from '../src/fullseed/repair.mjs';
import { createRepairLlmProvider, buildRepairMessages } from '../src/fullseed/repair-provider.mjs';

test('repair provider sends caller REPAIR_PROMPT, raw chunk and chunkId; returns raw text', async () => {
  const seen = [];
  const llm = {
    async *stream(request) {
      seen.push(request);
      yield { type: 'text-delta', text: '```json\n{"chunkId":"c1","L":"一句摘要","concreteNouns":["x"]}\n```' };
      yield { type: 'usage', usage: { totalTokens: 9 } };
    },
  };
  const provider = createRepairLlmProvider({ llm });
  const chunk = 'raw chunk 原文';
  const result = await provider({ prompt: REPAIR_PROMPT, chunk, chunkId: 'c1' });
  assert.equal(seen.length, 1);
  assert.match(seen[0].messages[0].content, new RegExp(REPAIR_PROMPT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(seen[0].messages[0].content, /raw chunk 原文/);
  assert.match(seen[0].messages[0].content, /chunkId: c1/);
  assert.equal(result.chunkId, 'c1');
  assert.match(result.text, /一句摘要/);
  assert.equal(normalizeL(result), '一句摘要');
});

test('repair module does not call legacy createFullseedLlmProvider', () => {
  const source = fs.readFileSync(new URL('../src/fullseed/repair-provider.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /createFullseedLlmProvider/);
  assert.equal(buildRepairMessages({ prompt: REPAIR_PROMPT, chunk: 'x', chunkId: 'c' }).length, 1);
});
