import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeepseekStream } from '../src/fullseed/provider.mjs';
import { createLlmSummaryProvider } from '../src/turn-ping/host-adapters.mjs';

test('direct DeepSeek stream preserves HTTP status and provider detail without network', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-direct-'));
  const credentials = path.join(home, 'credentials.yaml');
  fs.writeFileSync(credentials, 'DEEPSEEK_API_KEY: fake-test-key\n');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'invalid test request' } }), { status: 400 });
  try {
    const llm = { stream: createDeepseekStream({ credentials, endpoint: 'https://example.invalid/messages' }) };
    const provider = createLlmSummaryProvider({ llm, provider: 'deepseek-official', model: 'deepseek-flash' });
    await assert.rejects(
      provider({ turn: { turnId: 'turn-1' }, sourceView: 'raw' }),
      /fullseed anthropic 400.*invalid test request/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('public adapter diagnostics do not use the retired turn-ping prefix', () => {
  const source = fs.readFileSync(new URL('../src/turn-ping/host-adapters.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /turn-ping provider|turn-ping adapter|turn-ping embedder/);
});
