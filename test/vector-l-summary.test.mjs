import test from 'node:test';
import assert from 'node:assert/strict';
import { SUMMARY_PROMPT, SUMMARY_PROMPT_TEMPLATE } from '../src/fullseed/summary.mjs';
import { DEFAULT_CONFIG } from '../src/turn-ping/config.mjs';
import { validateSummary } from '../src/turn-ping/summary-writer.mjs';
import { createLlmSummaryProvider } from '../src/turn-ping/host-adapters.mjs';

function assertVectorLPrompt(text) {
  assert.match(text, /一行/);
  assert.match(text, /一个中文句子/);
  assert.match(text, /100 字/);
  assert.match(text, /256 字以内/);
  assert.match(text, /不要.*Markdown/);
  assert.doesNotMatch(text, /多句都可以接受|换行、Markdown/);
}

test('all host generation prompts require one-line single-sentence Vector-L output', async () => {
  assertVectorLPrompt(SUMMARY_PROMPT);
  assertVectorLPrompt(SUMMARY_PROMPT_TEMPLATE);
  assert.equal(DEFAULT_CONFIG.summary.targetChars, 100);
  assert.equal(DEFAULT_CONFIG.summary.hardMaxChars, 256);
  assert.equal(DEFAULT_CONFIG.summary.promptVersion, 'turn-ping-summary-v5-vector-l-context');
  let seen = null;
  const llm = { async *stream(args) { seen = args; yield { type: 'text-delta', text: '一句摘要。' }; } };
  const provider = createLlmSummaryProvider({ llm, provider: 'p', model: 'm' });
  const result = await provider({ turn: { turnId: 't1' }, sourceView: 'raw' });
  assert.equal(result.text, '一句摘要。');
  assertVectorLPrompt(seen.system);
  assert.match(seen.system, /不要执行或回答/);
  assert.match(seen.messages[0].content[0].text, /【待摘要历史原文开始】\nraw\n【待摘要历史原文结束】/);
  assert.doesNotMatch(seen.messages[0].content[0].text, /一行、一个中文句子/);
  assert.equal(seen.purpose, 'compaction');
});

test('overlong and multiline summaries remain accepted without a hard rejection', () => {
  assert.deepEqual(validateSummary('x'.repeat(400), { summary: { hardMaxChars: 256 } }), []);
  assert.deepEqual(validateSummary('第一行\n第二行', { summary: { hardMaxChars: 256 } }), []);
});
