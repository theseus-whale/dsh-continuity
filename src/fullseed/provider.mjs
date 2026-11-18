import fs from 'node:fs';
import { createFullseedLlmProvider } from './llm-adapter.mjs';
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
    throw new Error(`fullseed provider: credentials path not configured; pass credentials or set ${CREDENTIALS_ENV}`);
  }
  return value;
}

function apiKey(credentials) {
  const text = fs.readFileSync(credentials, 'utf8');
  const match = text.match(/^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m);
  if (!match) throw new Error('DEEPSEEK_API_KEY not found in configured credentials file');
  return match[1];
}

/** DeepSeek Anthropic-compatible streaming transport. Injectable for tests. */
export function createDeepseekStream({ credentials, endpoint = process.env[ENDPOINT_ENV] ?? DEFAULT_ENDPOINT } = {}) {
  const credentialPath = resolveCredentialPath({ credentials });
  return async function* stream({ provider, model, temperature, maxTokens, messages, thinking }) {
    if (!provider || !model) throw new Error('fullseed stream: provider/model required');
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey(credentialPath), 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens ?? 800,
        temperature: temperature ?? 0,
        messages,
        thinking: thinking ?? { type: 'disabled' },
        stream: true,
      }),
    });
    if (!response.ok) throw new Error(`fullseed anthropic ${response.status}: ${(await response.text()).slice(0, 1000)}`);
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
            else if (event.type === 'error') throw new Error(`fullseed stream error: ${JSON.stringify(event.error)}`);
          }
        }
      }
    } finally {
      reader.releaseLock?.();
    }
  };
}

/**
 * Packaged fullseed provider: returns { provider, embedder }. The provider
 * receives the caller's fullseed prompt and raw chunk; it does not bind a
 * repair prompt and does not use a subagent. Credentials and routing are
 * explicit (args/env), never a hardcoded user home path.
 */
export async function createProvider({ llm = null, embedder = null, credentials, endpoint, provider = process.env[PROVIDER_ENV] ?? 'deepseek-official', model = process.env[MODEL_ENV] ?? 'deepseek-flash' } = {}) {
  let stream = llm;
  if (!stream) {
    const credentialPath = resolveCredentialPath({ credentials });
    stream = { stream: createDeepseekStream({ credentials: credentialPath, endpoint }) };
  }
  const llmProvider = createFullseedLlmProvider({ llm: stream, provider, model, maxTokens: 800 });
  return { provider: llmProvider, embedder: embedder ?? createBgeEmbedder({ model: './models/Xenova/bge-small-zh-v1.5' }) };
}
