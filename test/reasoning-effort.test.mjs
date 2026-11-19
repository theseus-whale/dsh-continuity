import test from 'node:test';
import assert from 'node:assert/strict';
import { createFullseedLlmProvider } from '../src/fullseed/llm-adapter.mjs';
import { createLlmSummaryProvider } from '../src/turn-ping/host-adapters.mjs';

function captureLlm(seen) {
  return {
    async *stream(args) {
      seen.args = args;
      yield { type: 'text-delta', text: '本轮确认了摘要请求使用非推理模式。' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

test('fullseed summary requests explicitly disable reasoning without losing routing metadata', async () => {
  const seen = {};
  const provider = createFullseedLlmProvider({ llm: captureLlm(seen), provider: 'deepseek-official', model: 'deepseek-flash' });
  const result = await provider({ chunk: '原文', chunkId: 'chunk-1', sessionId: 'session-current' });
  assert.equal(result.text, '本轮确认了摘要请求使用非推理模式。');
  assert.equal(seen.args.reasoningEffort, 'off');
  assert.equal(seen.args.maxTokens, 800);
  assert.equal(seen.args.sessionId, 'session-current');
  assert.equal(seen.args.purpose, 'compaction');
  assert.equal(seen.args.provider, 'deepseek-official');
  assert.equal(seen.args.model, 'deepseek-flash');
});

test('incremental summary requests explicitly disable reasoning without losing routing metadata', async () => {
  const seen = {};
  const provider = createLlmSummaryProvider({ llm: captureLlm(seen), provider: 'deepseek-official', model: 'deepseek-flash' });
  const result = await provider({ turn: { turnId: 'turn-1', sessionId: 'session-current' }, sourceView: '原文' });
  assert.equal(result.text, '本轮确认了摘要请求使用非推理模式。');
  assert.equal(seen.args.reasoningEffort, 'off');
  assert.equal(seen.args.maxTokens, 800);
  assert.equal(seen.args.sessionId, 'session-current');
  assert.equal(seen.args.purpose, 'compaction');
  assert.equal(seen.args.provider, 'deepseek-official');
  assert.equal(seen.args.model, 'deepseek-flash');
});
