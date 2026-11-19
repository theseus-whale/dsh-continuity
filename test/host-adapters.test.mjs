import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLlmSummaryProvider, createBgeEmbedder } from '../src/turn-ping/host-adapters.mjs';
import { createFullseedLlmProvider } from '../src/fullseed/llm-adapter.mjs';

test('summary provider preserves model failure code and root cause', async () => {
  const root = new Error('socket reset');
  const failure = new Error('DeepSeek Messages transport failed', { cause: root });
  failure.code = 'TRANSPORT';
  const llm = { async *stream() { yield { type: 'finish', reason: { kind: 'error', failure } }; } };
  const provider = createLlmSummaryProvider({ llm, provider: 'p', model: 'm' });
  await assert.rejects(
    provider({ turn: { turnId: 'turn-1' }, sourceView: 'raw' }),
    (error) => error.message.includes('[TRANSPORT]') && error.cause === failure && error.cause.cause === root,
  );
});

test('embedder requires a complete local Xenova directory before loading', async () => {
  const model = fs.mkdtempSync(path.join(os.tmpdir(), 'xenova-missing-'));
  let factoryCalls = 0;
  const embedder = createBgeEmbedder({ model, transformerFactory: async () => { factoryCalls += 1; } });
  await assert.rejects(embedder('raw'), /local Xenova model is incomplete/);
  assert.equal(factoryCalls, 0);
  await assert.rejects(createBgeEmbedder({ model: 'Xenova/bge-small-zh-v1.5' })('raw'), /absolute local directory/);
});

test('complete local model is loaded from the supplied directory', async () => {
  const model = fs.mkdtempSync(path.join(os.tmpdir(), 'xenova-local-'));
  for (const file of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) fs.writeFileSync(path.join(model, file), '{}\n');
  fs.mkdirSync(path.join(model, 'onnx'));
  fs.writeFileSync(path.join(model, 'onnx', 'model_quantized.onnx'), 'test');
  let seen = null;
  const embedder = createBgeEmbedder({
    model,
    transformerFactory: async (_task, resolved) => {
      seen = resolved;
      return async () => ({ data: Float32Array.from({ length: 512 }, () => 1) });
    },
  });
  const vector = await embedder('raw');
  assert.equal(vector.length, 512);
  assert.equal(seen, model);
});


test('fullseed Host adapter forwards session ID and preserves failure code/cause', async () => {
  let seen = null;
  const llm = { async *stream(args) { seen = args; yield { type: 'text-delta', text: '一句摘要。' }; } };
  const provider = createFullseedLlmProvider({ llm, provider: 'p', model: 'm' });
  const result = await provider({ chunk: 'raw', chunkId: 'c1', sessionId: 'session-current' });
  assert.equal(result.text, '一句摘要。');
  assert.equal(seen.sessionId, 'session-current');
  assert.equal(seen.purpose, 'compaction');
  assert.equal(seen.messages[0].content[0].type, 'text');
  assert.match(seen.messages[0].content[0].text, /raw/);

  const root = new Error('gateway detail');
  const failure = new Error('DeepSeek Messages transport failed', { cause: root });
  failure.code = 'TRANSPORT';
  const broken = createFullseedLlmProvider({
    llm: { async *stream() { yield { type: 'finish', reason: { kind: 'error', failure } }; } },
    provider: 'p', model: 'm',
  });
  await assert.rejects(
    broken({ chunk: 'raw', chunkId: 'c1', sessionId: 'session-current' }),
    error => error.message.includes('[TRANSPORT]') && error.cause === failure && error.cause.cause === root,
  );
});


test('fullseed Host adapter uses completed text blocks when no deltas are emitted', async () => {
  const llm = { async *stream() {
    yield { type: 'block-end', block: { type: 'text', text: '来自 block-end 的一句摘要。' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } };
  const provider = createFullseedLlmProvider({ llm, provider: 'p', model: 'm' });
  const result = await provider({ chunk: 'raw', chunkId: 'c1', sessionId: 's' });
  assert.equal(result.text, '来自 block-end 的一句摘要。');
  assert.equal(result.streamStats.completedBlockChars > 0, true);
});
