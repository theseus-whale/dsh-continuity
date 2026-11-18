/**
 * Real host adapters. They are constructed only when explicitly configured;
 * nothing here is loaded or called by default.
 */
export function createLlmSummaryProvider({ llm, provider, model, system = null, maxTokens = 800 }) {
  if (!llm || typeof llm.stream !== 'function') throw new Error('memory summary adapter: ctx.llm unavailable');
  if (!provider || !model) throw new Error('memory summary adapter: provider/model required');
  return async ({ turn, sourceView }) => {
    const messages = [{ role: 'user', content: `请直接写一段便于以后检索的中文摘要。只依据原文，不补写。不要输出 JSON、不要重复 turnId、不要使用代码块；约 256 字是软目标，可以超出。换行、Markdown 和多句都可以接受。\n\n${sourceView}` }];
    let text = '';
    let usage = null;
    for await (const chunk of llm.stream({ provider, model, temperature: 0, maxTokens, ...(system ? { system } : {}), messages })) {
      if (chunk?.type === 'text-delta') text += chunk.text ?? '';
      else if (chunk?.type === 'usage') usage = chunk.usage ?? null;
      else if (chunk?.type === 'finish' && chunk?.reason?.kind === 'error') {
        const failure = chunk.reason.failure;
        const message = failure?.message ?? 'model error';
        const code = failure?.code ?? failure?.failure?.code ?? null;
        const cause = failure instanceof Error ? failure : new Error(message, { cause: failure?.cause });
        throw new Error(`memory summary provider${code ? ` [${code}]` : ''}: ${message}`, { cause });
      }
    }
    return { text, provider, model, usage };
  };
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];

export function createBgeEmbedder({ model = 'Xenova/bge-small-zh-v1.5', transformerFactory = null } = {}) {
  let extractor = null;
  const packageRelative = model.startsWith('./');
  const local = packageRelative || path.isAbsolute(model);
  const resolvedModel = packageRelative
    ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', model.slice(2))
    : model;
  const load = async () => {
    if (extractor) return extractor;
    if (!local) throw new Error('memory embedder: provide an absolute local directory for Xenova/bge-small-zh-v1.5; see INSTALL.md');
    const missing = MODEL_FILES.filter((file) => !fs.existsSync(path.join(resolvedModel, file)));
    if (missing.length > 0) throw new Error(`memory embedder: local Xenova model is incomplete; obtain Xenova/bge-small-zh-v1.5 before enabling memory features (missing: ${missing.join(', ')})`);
    const factory = transformerFactory ?? (await import('@huggingface/transformers')).pipeline;
    extractor = await factory('feature-extraction', resolvedModel, { dtype: 'q8' });
    return extractor;
  };
  return async (text, kind = 'document') => {
    const pipe = await load();
    const input = kind === 'query' ? `为这个句子生成表示以用于检索相关文章：${text}` : String(text);
    const output = await pipe(input, { pooling: 'cls', normalize: true });
    const data = Array.from(output?.data ?? output?.[0]?.data ?? []);
    if (data.length !== 512) throw new Error(`memory summary embedder: expected 512 dimensions, got ${data.length}`);
    return data;
  };
}

export const HOST_ADAPTER_STATUS = Object.freeze({
  summaryProvider: 'available only when ctx.llm + provider/model are explicitly configured',
  embedder: 'available only with local @huggingface/transformers and explicit BGE model',
  default: 'not constructed; memory summary disabled',
});
