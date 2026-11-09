import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PreTurnController } from '../src/memory/pre-turn.mjs';
import { MemoryLoadState } from '../src/memory/load-gate.mjs';
import { createCacheProvider, createCommandProvider, createExtractionProviderFromEnv, createPersistentCommandProvider, resolveExtractionMode, splitArgs, stepWithProvider } from '../src/memory/extraction-provider.mjs';

const run = { activity: '跑团', topic: '剧情' };
const dev = { activity: '开发', topic: '技术' };
const records = [
  { turn: 1, seqStart: 10, seqEnd: 10, text: '写插件', facets: { ...dev, medium: '文字' }, hash: 'a' },
  { turn: 2, seqStart: 20, seqEnd: 20, text: '进灯室', facets: { ...run, medium: '文字' }, hash: 'b' },
];

function cacheFile(text, value) {
  const key = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  const file = path.join(os.tmpdir(), `extraction-cache-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify({ [key]: value }));
  return file;
}

test('splitArgs preserves quoted paths with spaces and apostrophes', () => {
  assert.deepEqual(
    splitArgs('--flag "C:\\Users\\35794\\Documents\\DeepSeek\'s Sandbox\\bin\\x.py"'),
    ['--flag', 'C:\\Users\\35794\\Documents\\DeepSeek\'s Sandbox\\bin\\x.py'],
  );
  assert.deepEqual(splitArgs('["--flag", "C:\\\\path with space\\\\x.py"]'), ['--flag', 'C:\\path with space\\x.py']);
  assert.deepEqual(splitArgs("'a b' c"), ['a b', 'c']);
});

test('mode defaults to off', () => {
  assert.equal(resolveExtractionMode({}), 'off');
  assert.equal(resolveExtractionMode({ DSH_EXTRACTION_MODE: 'cache' }), 'cache');
  assert.equal(resolveExtractionMode({ DSH_EXTRACTION_MODE: 'model' }), 'model');
});

test('cache provider hits and fails closed on miss', async () => {
  const text = '我们现在开始跑团，进灯室';
  const file = cacheFile(text, { slots: { characters: ['宁'], location: '灯室', objects: ['钥匙'] } });
  const provider = createCacheProvider({ cachePath: file, mode: 'cache' });
  const hit = await provider.extract({ text });
  assert.equal(hit.ok, true);
  assert.equal(hit.data.slots.location, '灯室');
  const miss = await provider.extract({ text: '没有缓存' });
  assert.equal(miss.ok, false);
  assert.equal(miss.reason, 'cache-miss');
});

test('cache provider rejects invalid slots', async () => {
  const text = '坏槽';
  const file = cacheFile(text, { slots: { location: 42 } });
  const provider = createCacheProvider({ cachePath: file, mode: 'cache' });
  const result = await provider.extract({ text });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid-slots');
});

test('factory defaults to off and selects cache', async () => {
  const off = createExtractionProviderFromEnv({});
  assert.equal(off.mode, 'off');
  const missing = await off.extract({ text: 'x' });
  assert.equal(missing.reason, 'disabled');
  const cache = createExtractionProviderFromEnv({ DSH_EXTRACTION_MODE: 'cache' });
  assert.equal(cache.mode, 'cache');
});

test('factory model without command fails closed', async () => {
  const provider = createExtractionProviderFromEnv({ DSH_EXTRACTION_MODE: 'model' });
  const result = await provider.extract({ text: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-command');
});

test('command provider runs a model-side process', async () => {
  const provider = createCommandProvider({
    command: process.execPath,
    args: [path.join(import.meta.dirname, 'fixtures', 'extraction-echo.mjs')],
    timeoutMs: 5000,
  });
  const result = await provider.extract({ text: '进灯室' });
  assert.equal(result.ok, true);
  assert.equal(result.data.slots.location, '灯室');
  assert.deepEqual(result.data.slots.characters, ['宁']);
});

test('pre-turn stepAsync accepts a provider', async () => {
  const text = '我们现在开始跑团，进灯室';
  const file = cacheFile(text, { slots: { characters: ['宁'], location: '灯室', objects: ['钥匙'] } });
  const controller = new PreTurnController({
    records,
    gate: new MemoryLoadState({ loadedFacets: dev, loadedAtTurn: 1 }),
  });
  const provider = createCacheProvider({ cachePath: file, mode: 'cache' });
  const result = await controller.stepAsync({
    extractionProvider: provider,
    text,
    facets: run,
    confidence: 0.9,
    nowTurn: 5,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.slots.characters, ['宁']);
  assert.equal(result.gate.action, 'load');
});

test('factory builds composite from a config file', async () => {
  const fixture = path.join(import.meta.dirname, 'fixtures', 'extraction-config-echo.mjs');
  const config = path.join(os.tmpdir(), `extraction-config-${crypto.randomUUID()}.json`);
  const service = { command: process.execPath, args: [fixture], persistent: false };
  fs.writeFileSync(config, JSON.stringify({ services: { ner: service, coref: service, srl: service, el: service } }));
  const provider = createExtractionProviderFromEnv({ DSH_EXTRACTION_MODE: 'model', DSH_EXTRACTION_CONFIG: config });
  try {
    const result = await provider.extract({ text: '宁进灯室' });
    assert.equal(result.ok, true);
    assert.equal(result.data.slots.location, '灯室');
    assert.equal(result.data.partial.srl.ok, true);
    assert.equal(result.data.partial.el.ok, true);
    assert.equal(result.data.entityLinks[0].text, '宁');
  } finally {
    provider.close?.();
  }
});

test('persistent provider timeout fails closed', async () => {
  const provider = createPersistentCommandProvider({
    command: process.execPath,
    args: [path.join(import.meta.dirname, 'fixtures', 'extraction-persistent-hang.mjs')],
    timeoutMs: 100,
  });
  try {
    const result = await provider.extract({ text: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'timeout');
  } finally {
    provider.close();
  }
});

test('persistent provider process exit fails closed', async () => {
  const provider = createPersistentCommandProvider({
    command: process.execPath,
    args: [path.join(import.meta.dirname, 'fixtures', 'extraction-persistent-exit.mjs')],
    timeoutMs: 5000,
  });
  const result = await provider.extract({ text: 'x' });
  assert.equal(result.ok, false);
  provider.close();
});

test('factory can select persistent model provider', async () => {
  const provider = createExtractionProviderFromEnv({
    DSH_EXTRACTION_MODE: 'model',
    DSH_EXTRACTION_PERSISTENT: '1',
    DSH_EXTRACTION_COMMAND: process.execPath,
    DSH_EXTRACTION_ARGS: JSON.stringify([path.join(import.meta.dirname, 'fixtures', 'extraction-persistent-echo.mjs')]),
  });
  try {
    const first = await provider.extract({ text: '进灯室' });
    const second = await provider.extract({ text: '进灯室' });
    assert.equal(provider.persistent, true);
    assert.equal(first.data.pid, second.data.pid);
  } finally {
    provider.close();
  }
});

test('persistent provider keeps one process across requests', async () => {
  const provider = createPersistentCommandProvider({
    command: process.execPath,
    args: [path.join(import.meta.dirname, 'fixtures', 'extraction-persistent-echo.mjs')],
    timeoutMs: 5000,
  });
  try {
    const first = await provider.extract({ text: '进灯室' });
    const second = await provider.extract({ text: '进灯室' });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.data.slots.location, '灯室');
    assert.equal(first.data.pid, second.data.pid);
  } finally {
    provider.close();
  }
});

test('provider miss still lets the gate run', async () => {
  const controller = new PreTurnController({
    records,
    gate: new MemoryLoadState({ loadedFacets: dev, loadedAtTurn: 1 }),
  });
  const provider = createCacheProvider({ cachePath: null, mode: 'cache' });
  const result = await stepWithProvider(controller, provider, {
    text: '我们现在开始跑团，进灯室',
    facets: run,
    confidence: 0.9,
    nowTurn: 5,
  });
  assert.equal(result.ok, false);
  assert.equal(result.extraction.reason, 'cache-miss');
  assert.equal(result.gate.action, 'load');
});

test('provider hit feeds structured slots into the gate', async () => {
  const text = '我们现在开始跑团，进灯室';
  const file = cacheFile(text, { slots: { characters: ['宁'], location: '灯室', objects: ['钥匙'] } });
  const controller = new PreTurnController({
    records,
    gate: new MemoryLoadState({ loadedFacets: dev, loadedAtTurn: 1 }),
  });
  const provider = createCacheProvider({ cachePath: file, mode: 'cache' });
  const result = await stepWithProvider(controller, provider, {
    text,
    facets: run,
    confidence: 0.9,
    nowTurn: 5,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.slots.characters, ['宁']);
  assert.equal(result.gate.action, 'load');
});
