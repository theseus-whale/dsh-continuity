import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCacheProvider } from '../src/memory/extraction-provider.mjs';
import { createExtractionPreStep, installExtractionPreStep } from '../src/memory/extraction-pre-step.mjs';

function cacheFile(text, value) {
  const key = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  const file = path.join(os.tmpdir(), `extraction-pre-step-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify({ [key]: value }));
  return file;
}

const decision = {
  kind: 'accept',
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'system' }] },
    { role: 'user', content: [{ type: 'text', text: '我们先开始跑团' }] },
  ],
};

test('cache provider injects once at step 1 only', async () => {
  const file = cacheFile('我们先开始跑团', {
    slots: { characters: ['宁'], location: '灯室', objects: ['钥匙'] },
    entityLinks: [{ text: '宁', entityId: 'p:1' }],
  });
  const handler = createExtractionPreStep({
    mode: 'cache',
    provider: createCacheProvider({ cachePath: file, mode: 'cache' }),
  });
  const first = await handler({ step: 1 }, async () => decision);
  assert.equal(first.messages.length, decision.messages.length + 1);
  assert.match(first.messages.at(-1).content[0].text, /characters: 宁/);
  assert.match(first.messages.at(-1).content[0].text, /links: 宁=p:1/);
  assert.doesNotMatch(first.messages.at(-1).content[0].text, /undefined/);
  const second = await handler({ step: 2 }, async () => decision);
  assert.equal(second.messages.length, decision.messages.length);
});

test('installed cache handler injects once at step 1', async () => {
  const file = cacheFile('我们先开始跑团', { slots: { characters: ['宁'], location: '灯室', objects: [] } });
  const events = [];
  const ctx = { on: (name, handler) => events.push({ name, handler }) };
  const installed = installExtractionPreStep(ctx, {
    DSH_EXTRACTION_MODE: 'cache',
    DSH_EXTRACTION_CACHE: file,
  });
  assert.equal(installed.registered, true);
  assert.equal(events.length, 1);
  const first = await events[0].handler({ step: 1 }, async () => decision);
  assert.equal(first.messages.length, decision.messages.length + 1);
  const second = await events[0].handler({ step: 2 }, async () => decision);
  assert.equal(second.messages.length, decision.messages.length);
});

test('cache miss does not inject at step 1', async () => {
  const handler = createExtractionPreStep({
    mode: 'cache',
    provider: createCacheProvider({ cachePath: null, mode: 'cache' }),
  });
  const result = await handler({ step: 1 }, async () => decision);
  assert.equal(result.messages.length, decision.messages.length);
  assert.equal(result.extraction.reason, 'cache-miss');
});
