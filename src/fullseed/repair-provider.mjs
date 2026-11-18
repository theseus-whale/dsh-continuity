import fs from 'node:fs';
import { REPAIR_PROMPT, REPAIR_PROMPT_SHA256 } from './repair.mjs';
import { createBgeEmbedder } from '../turn-ping/host-adapters.mjs';

const CREDENTIALS_ENV = 'DSH_CONTINUITY_CREDENTIALS';
const ENDPOINT_ENV = 'DSH_CONTINUITY_ENDPOINT';
const PROVIDER_ENV = 'DSH_CONTINUITY_PROVIDER';
const MODEL_ENV = 'DSH_CONTINUITY_MODEL';
const DEFAULT_ENDPOINT = 'https://api.deepseek.com/anthropic/v1/messages';

export function resolveCredentialPath({ credentials } = {}) {
  const value = typeof credentials === 'string' && credentials.length > 0
    ? credentials
    : process.env[CREDENTIALS_ENV];
  if (!value) {
    throw new Error(`repair provider: credentials path not configured; pass credentials or set ${CREDENTIALS_ENV}`);
  }
  return value;
}

function apiKey(credentials) {
  const text = fs.readFileSync(credentials, 'utf8');
  const match = text.match(/^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m);
  if (!match) throw new Error('DEEPSEEK_API_KEY not found in configured credentials file');
  return match[1];
}

/** The actual user message must carry caller REPAIR_PROMPT, chunkId, and raw chunk. */
export function buildRepairMessages({ prompt, chunk, chunkId }) {
  if (prompt !== REPAIR_PROMPT) throw new Error('repair provider: caller prompt is not REPAIR_PROMPT');
  if (typeof chunk !== 'string' || chunk.length === 0) throw new Error('repair provider: raw chunk missing');
  if (typeof chunkId !== 'string' || chunkId.length === 0) throw new Error('repair provider: chunkId missing');
  return [{
    role: 'user',
    content: `${prompt}\nchunkId: ${chunkId}\nraw chunk:\n${chunk}`,
  }];
}

/** Injectable LLM adapter: returns the model's raw text for normalizeL. */
export function createRepairLlmProvider({ llm, provider = process.env[PROVIDER_ENV] ?? 'deepseek-official', model = process.env[MODEL_ENV] ?? 'deepseek-flash', maxTokens = 800 }) {
  if (!llm || typeof llm.stream !== 'function') throw new Error('repair provider: llm.stream required');
  return async ({ prompt, chunk, chunkId }) => {
    const messages = buildRepairMessages({ prompt, chunk, chunkId });
    let text = '';
    let usage = null;
    for await (const event of llm.stream({ provider, model, temperature: 0, maxTokens, messages, thinking: { type: 'disabled' } })) {
      if (event?.type === 'text-delta') text += event.text ?? '';
      else if (event?.type === 'usage') usage = event.usage ?? null;
      else if (event?.type === 'finish' && event?.reason?.kind === 'error') throw new Error(`repair provider: ${event.reason.failure?.message ?? 'model error'}`);
    }
    return { chunkId, text, rawText: text, usage, provider, model, promptTextSha256: REPAIR_PROMPT_SHA256 };
  };
}

async function* anthropicStream({ endpoint, credentials, provider, model, temperature, maxTokens, messages, thinking }) {
  const key = apiKey(credentials);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: maxTokens ?? 800, temperature: temperature ?? 0, messages, thinking: thinking ?? { type: 'disabled' }, stream: true }),
  });
  if (!response.ok) throw new Error(`repair anthropic ${response.status}: ${(await response.text()).slice(0, 1000)}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of block.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let event;
          try { event = JSON.parse(data); } catch { continue; }
          if (event.type === 'content_block_delta' && typeof event.delta?.text === 'string') yield { type: 'text-delta', text: event.delta.text };
          else if (event.type === 'message_delta' && event.usage) yield { type: 'usage', usage: { totalTokens: event.usage.output_tokens ?? null } };
          else if (event.type === 'message_stop') return;
          else if (event.type === 'error') throw new Error(`repair stream error: ${JSON.stringify(event.error)}`);
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}

export async function createProvider({ llm = null, embedder = null, credentials, endpoint = process.env[ENDPOINT_ENV] ?? DEFAULT_ENDPOINT, provider = process.env[PROVIDER_ENV] ?? 'deepseek-official', model = process.env[MODEL_ENV] ?? 'deepseek-flash' } = {}) {
  let stream = llm;
  if (!stream) {
    const credentialPath = resolveCredentialPath({ credentials });
    stream = { stream: (request) => anthropicStream({ ...request, endpoint, credentials: credentialPath }) };
  }
  return { provider: createRepairLlmProvider({ llm: stream, provider, model }), embedder: embedder ?? createBgeEmbedder({ model: './models/Xenova/bge-small-zh-v1.5' }) };
}
