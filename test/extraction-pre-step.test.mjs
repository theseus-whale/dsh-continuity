import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createExtractionPreStep, installExtractionPreStep, lastUserText, recordExtractionInstallError, registerExtractionPreStep } from '../src/memory/extraction-pre-step.mjs';

const messages = [
  { role: 'system', content: [{ type: 'text', text: 'system' }] },
  { role: 'user', content: [{ type: 'text', text: '我们先开始跑团' }] },
];
const decision = { kind: 'accept', messages };

test('registration is opt-in and off is a no-op', () => {
  const events = [];
  const ctx = { on: (name, handler) => events.push({ name, handler }) };
  assert.equal(registerExtractionPreStep(ctx, { mode: 'off', provider: { extract: async () => ({ ok: true }) } }), false);
  assert.equal(events.length, 0);
  assert.equal(registerExtractionPreStep(ctx, { mode: 'cache', provider: { extract: async () => ({ ok: true }) } }), true);
  assert.equal(events[0].name, 'agent/pre-step');
});

test('install is a no-op at off and opt-in at cache', () => {
  const events = [];
  const ctx = { on: (name, handler) => events.push({ name, handler }) };
  assert.equal(installExtractionPreStep(ctx, {}).registered, false);
  assert.equal(events.length, 0);
  const installed = installExtractionPreStep(ctx, { DSH_EXTRACTION_MODE: 'cache' });
  assert.equal(installed.registered, true);
  assert.equal(events[0].name, 'agent/pre-step');
});

test('install failure is written to gate-errors.jsonl', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'extraction-install-'));
  const logs = [];
  recordExtractionInstallError(new Error('boom-register'), { home, log: { warn: (message) => logs.push(message) } });
  const file = path.join(home, '.dsh', 'continuity', 'gate-errors.jsonl');
  assert.equal(fs.existsSync(file), true);
  assert.match(fs.readFileSync(file, 'utf8'), /extraction-pre-step-register/);
  assert.equal(logs.length, 1);
});

test('lastUserText finds the last user text', () => {
  assert.equal(lastUserText(messages), '我们先开始跑团');
});

test('off returns the decision unchanged', async () => {
  const handler = createExtractionPreStep({ mode: 'off', provider: { extract: async () => ({ ok: true }) } });
  const result = await handler({}, async () => decision);
  assert.equal(result, decision);
});

test('extraction hit appends one context message', async () => {
  const handler = createExtractionPreStep({
    mode: 'cache',
    provider: {
      async extract() {
        return {
          ok: true,
          data: {
            lang: 'zh',
            slots: { characters: ['宁'], location: '灯室', objects: ['钥匙'], goal: null },
            entityLinks: [{ text: '宁', referent: 'p:1' }],
          },
        };
      },
    },
  });
  const result = await handler({ step: 1 }, async () => decision);
  assert.equal(result.messages.length, 3);
  assert.equal(result.messages.length, decision.messages.length + 1);
  const text = result.messages.at(-1).content[0].text;
  assert.match(text, /characters: 宁/);
  assert.match(text, /location: 灯室/);
  assert.match(text, /links: 宁=p:1/);
  assert.equal(result.extraction.ok, true);
});

test('later steps do not re-inject extraction', async () => {
  const handler = createExtractionPreStep({
    mode: 'cache',
    provider: { async extract() { return { ok: true, data: { slots: {} } }; } },
  });
  const result = await handler({ step: 2 }, async () => decision);
  assert.equal(result, decision);
});

test('recall line is injected even when extraction has no slots', async () => {
  const handler = createExtractionPreStep({
    mode: 'cache',
    provider: { async extract() { return { ok: true, data: { slots: {} } }; } },
    recall: async () => '[追忆] turn 49 / seq 120\n灯塔 / 钥匙',
  });
  const result = await handler({ step: 1 }, async () => decision);
  assert.equal(result.messages.length, decision.messages.length + 1);
  assert.match(result.messages.at(-1).content[0].text, /\[追忆\]/);
});

test('install wires sessionQuery recall into pre-step', async () => {
  const events = [
    { type: 'user/message', seq: 120, data: { turn: 49, content: [{ type: 'text', text: '我们上次去跑团，在灯塔找到钥匙。' }] } },
    { type: 'user/message', seq: 200, data: { turn: 51, content: [{ type: 'text', text: '我们接下来去跑团吧。' }] } },
  ];
  const events2 = [];
  const ctx = { on: (name, handler) => events2.push({ name, handler }) };
  const fixture = path.join(import.meta.dirname, 'fixtures', 'extraction-config-echo.mjs');
  const installed = installExtractionPreStep(ctx, {
    DSH_EXTRACTION_MODE: 'model',
    DSH_EXTRACTION_COMMAND: process.execPath,
    DSH_EXTRACTION_ARGS: JSON.stringify([fixture]),
  }, {
    sessionQuery: { async readSession() { return { events }; } },
  });
  assert.equal(installed.registered, true);
  const handler = events2[0].handler;
  const decision = {
    kind: 'accept',
    messages: [{ role: 'user', content: [{ type: 'text', text: '我们接下来去跑团吧。' }] }],
  };
  const result = await handler({ step: 1, agent: { session: { id: 's' }, lastTurn: 51 } }, async () => decision);
  assert.match(result.messages.at(-1).content[0].text, /\[追忆\]/);
  assert.match(result.messages.at(-1).content[0].text, /turn 49/);
});

test('empty extraction does not inject a noise line', async () => {
  const handler = createExtractionPreStep({
    mode: 'cache',
    provider: { async extract() { return { ok: true, data: { slots: { characters: [], location: null, objects: [], goal: null } } }; } },
  });
  const result = await handler({ step: 1 }, async () => decision);
  assert.equal(result.messages.length, decision.messages.length);
});

test('hit with controller goes through attachStructuredExtraction', async () => {
  const controller = { step: () => ({ action: 'load', reason: 'test' }) };
  const handler = createExtractionPreStep({
    mode: 'cache',
    controller,
    provider: { async extract() { return { ok: true, data: { slots: { characters: ['宁'], location: '灯室', objects: [] } } }; } },
  });
  const result = await handler({ step: 1 }, async () => decision);
  assert.equal(result.gate.action, 'load');
  assert.equal(result.messages.length, decision.messages.length + 1);
});

test('extraction failure does not append anything', async () => {
  const handler = createExtractionPreStep({
    mode: 'cache',
    provider: { async extract() { return { ok: false, reason: 'cache-miss' }; } },
  });
  const result = await handler({}, async () => decision);
  assert.equal(result.messages.length, decision.messages.length);
  assert.equal(result.extraction.reason, 'cache-miss');
});
