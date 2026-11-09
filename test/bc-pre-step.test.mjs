import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBCPreStep, installBCPreStep } from '../src/memory/bc-pre-step.mjs';
import { emptyStore, saveBCStore } from '../src/memory/bc-store.mjs';
import {
  createCMap, learnFromExplanation, makeRecord, queryFor, retrieve,
} from '../src/memory/bc-recall.mjs';

const records = [
  makeRecord({ turn: 40, seqStart: 2186, seqEnd: 2186, text: '灯塔钥匙', generic: ['游戏', '故事'], terms: ['跑团'] }),
];

test('queryFor picks a known term out of a sentence', () => {
  assert.equal(queryFor('我们接下来去跑团吧', { records, cmap: createCMap() }), '跑团');
});

test('explanation teaches C and backfills records', () => {
  const cmap = createCMap();
  const learned = learnFromExplanation(cmap, '跑团', '就是游戏、故事、对话', { records });
  assert.equal(learned.ok, true);
  assert.deepEqual(cmap.terms.get('跑团'), ['游戏', '故事', '对话']);
  const result = retrieve({ records: learned.records, cmap, query: '跑团' });
  assert.equal(result.kind, 'recall');
  assert.equal(result.via, 'C');
});

test('cue without an anchor stays silent', async () => {
  const cmap = createCMap();
  const handler = createBCPreStep({
    records,
    cmap,
    cmapFile: null,
    bLabeler: { label: async () => ({ candidates: [] }) },
  });
  const decision = { messages: [{ role: 'user', content: [{ type: 'text', text: '我们来回忆一下上次那个' }] }] };
  const result = await handler({ step: 1 }, async () => decision);
  assert.equal(result.messages.length, decision.messages.length);
});

test('pre-step injects recall after C learns', async () => {
  const cmap = createCMap();
  learnFromExplanation(cmap, '跑团', '游戏、故事、对话', { records });
  const handler = createBCPreStep({ records, cmap, cmapFile: null });
  const decision = { messages: [{ role: 'user', content: [{ type: 'text', text: '我们来回忆一下上次跑团' }] }] };
  const result = await handler({ step: 1 }, async () => decision);
  assert.match(result.messages.at(-1).content[0].text, /\[追忆\]/);
  assert.match(result.messages.at(-1).content[0].text, /turn 40/);
  assert.equal(result.messages.at(-1).source.kind, 'runtime-context');
});

test('install is off by default and registers only when enabled', () => {
  const events = [];
  const ctx = { on: (name, handler) => events.push({ name, handler }) };
  assert.equal(installBCPreStep(ctx, {}).registered, false);
  assert.equal(events.length, 0);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-install-')), 'store.json');
  const store = emptyStore();
  store.records.push(records[0]);
  saveBCStore(file, store);
  const installed = installBCPreStep(ctx, { enabled: true, storePath: file });
  assert.equal(installed.registered, true);
  assert.equal(events[0].name, 'agent/pre-step');
});

test('install loads a JSONL index and injects a cue note', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-jsonl-')), 'bc-index.jsonl');
  fs.writeFileSync(file, JSON.stringify({
    turn: 40, seqStart: 2186, seqEnd: 2186,
    generic: ['游戏', '故事'], terms: ['跑团'], keywords: ['钥匙'], status: 'weak',
  }) + '\n');
  const events = [];
  const ctx = { on: (name, handler) => events.push({ name, handler }) };
  const installed = installBCPreStep(ctx, { enabled: true, storePath: file });
  assert.equal(installed.registered, true);
  const handler = events[0].handler;
  const decision = { messages: [{ role: 'user', content: [{ type: 'text', text: '我们来回忆一下上次跑团的内容' }] }] };
  const result = await handler({ step: 1 }, async () => decision);
  assert.match(result.messages.at(-1).content[0].text, /\[问\]|\[追忆\]/);
});

test('special K alone does not trigger without a cue', async () => {
  const handler = createBCPreStep({
    records: [makeRecord({ turn: 1, seqStart: 1, seqEnd: 1, text: 'Coo 代码', generic: ['技术'], keywords: ['coo'] })],
    cmap: createCMap(),
  });
  const decision = { messages: [{ role: 'user', content: [{ type: 'text', text: 'Coo 的代码怎么改' }] }] };
  const result = await handler({ step: 1 }, async () => decision);
  assert.equal(result.messages.length, decision.messages.length);
});

test('one-character K names do not auto-trigger as vocatives', async () => {
  const handler = createBCPreStep({
    records: [makeRecord({ turn: 1, seqStart: 1, seqEnd: 1, text: '创的记录', keywords: ['创'], generic: [] })],
    cmap: createCMap(),
    cmapFile: null,
    bLabeler: { label: async () => ({ candidates: [] }) },
  });
  const decision = { messages: [{ role: 'user', content: [{ type: 'text', text: '创看看还有没有刷屏' }] }] };
  const result = await handler({ step: 1 }, async () => decision);
  assert.equal(result.messages.length, decision.messages.length);
});

test('one-character K names are not anchors even with a cue', async () => {
  const handler = createBCPreStep({
    records: [makeRecord({ turn: 1, seqStart: 1, seqEnd: 1, text: '创的记录', keywords: ['创'], generic: [] })],
    cmap: createCMap(),
    cmapFile: null,
    bLabeler: { label: async () => ({ candidates: [] }) },
  });
  const decision = { messages: [{ role: 'user', content: [{ type: 'text', text: '上次创说的那个问题' }] }] };
  const result = await handler({ step: 1 }, async () => decision);
  assert.equal(result.messages.length, decision.messages.length);
});

test('cue + C anchor uses the static index', async () => {
  const cmap = createCMap();
  learnFromExplanation(cmap, '跑团', '游戏、故事、对话', { records });
  const handler = createBCPreStep({
    records,
    cmap,
    cmapFile: null,
    bLabeler: { label: async () => ({ candidates: [] }) },
  });
  const decision = { messages: [{ role: 'user', content: [{ type: 'text', text: '我们来回忆一下上次跑团的内容' }] }] };
  const result = await handler({ step: 1, agent: { session: { id: 's' }, lastTurn: 601 } }, async () => decision);
  assert.match(result.messages.at(-1).content[0].text, /\[追忆\] 跑团/);
  assert.match(result.messages.at(-1).content[0].text, /turn 40/);
});

test('B anchor requires the concept word to be literally present', async () => {
  const handler = createBCPreStep({
    records: [makeRecord({ turn: 1, seqStart: 1, seqEnd: 1, text: '记忆', generic: ['记忆'], conceptScores: { 记忆: 0.9 }, status: 'weak' })],
    cmap: createCMap(),
    cmapFile: null,
    bLabeler: { label: async () => ({ candidates: [{ concept: '记忆', score: 0.95 }] }) },
  });
  for (const text of ['上次', '上次那个']) {
    const decision = { messages: [{ role: 'user', content: [{ type: 'text', text }] }] };
    const result = await handler({ step: 1 }, async () => decision);
    assert.equal(result.messages.length, decision.messages.length, text);
  }
});

test('anchor note displays at most 3 intervals and 5 lines', async () => {
  const many = Array.from({ length: 5 }, (_, index) => makeRecord({
    turn: 100 + index * 100,
    seqStart: 100 + index * 100,
    seqEnd: 100 + index * 100,
    text: '',
    generic: ['游戏'],
    terms: ['跑团'],
  }));
  const cmap = createCMap();
  learnFromExplanation(cmap, '跑团', '游戏', { records: many });
  const handler = createBCPreStep({ records: many, cmap, cmapFile: null });
  const decision = { messages: [{ role: 'user', content: [{ type: 'text', text: '上次跑团' }] }] };
  const result = await handler({ step: 1 }, async () => decision);
  const note = result.messages.at(-1).content[0].text;
  assert.match(note, /显示 3 \/ 共 5 个区间/);
  assert.equal(note.split('\n').length, 5);
});

test('cue + B anchor uses the current-input B score', async () => {
  const handler = createBCPreStep({
    records: [makeRecord({ turn: 1, seqStart: 1, seqEnd: 1, text: '技术讨论', generic: ['技术'], conceptScores: { 技术: 0.8 }, status: 'weak' })],
    cmap: createCMap(),
    cmapFile: null,
    bLabeler: { label: async () => ({ candidates: [{ concept: '技术', score: 0.8 }] }) },
  });
  const decision = { messages: [{ role: 'user', content: [{ type: 'text', text: '上次技术那个问题' }] }] };
  const result = await handler({ step: 1 }, async () => decision);
  assert.match(result.messages.at(-1).content[0].text, /\[追忆\] 技术/);
  assert.match(result.messages.at(-1).content[0].text, /更多用 recall\("技术"\)/);
});

