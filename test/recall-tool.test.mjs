import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRecallTool } from '../src/recall-tool.mjs';

test('recall tool returns candidate pointers, not raw text', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recall-tool-')), 'index.jsonl');
  fs.writeFileSync(file, JSON.stringify({
    turn: 40, seqStart: 2186, seqEnd: 2186,
    generic: ['游戏', '故事'], terms: ['跑团'], conceptScores: { 游戏: 0.9, 故事: 0.8 }, status: 'weak',
  }) + '\n');
  const tool = createRecallTool({ file });
  assert.equal(tool.name, 'recall');
  const result = JSON.parse(await tool.execute({ query: '游戏' }));
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'recall');
  assert.equal(result.candidates[0].turn, 40);
  assert.equal('text' in result.candidates[0], false);
});

test('recall recent uses live session and returns the newest turn', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recall-tool-')), 'index.jsonl');
  fs.writeFileSync(file, '');
  const events = [
    { type: 'user/message', seq: 2215, data: { turn: 41, content: [{ type: 'text', text: '上次跑团在灯塔' }] } },
    { type: 'user/message', seq: 56503, data: { turn: 600, content: [{ type: 'text', text: '我们来回忆一下上次跑团的内容' }] } },
  ];
  const tool = createRecallTool({ file, sessionQuery: { readSession: async () => ({ events }) } });
  const result = JSON.parse(await tool.execute({ query: '跑团', recent: true }, { agent: { session: { id: 's' } } }));
  assert.equal(result.ok, true);
  assert.equal(result.via, 'live');
  assert.equal(result.candidates[0].turn, 600);
  assert.equal(result.candidates[0].seqStart, 56503);
  assert.equal(result.intervals.length, 2);
  assert.match(result.note, /2 个区间/);
});

test('recall extracts a special keyword and combines it with a facet', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recall-tool-')), 'index.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ turn: 1, seqStart: 1, seqEnd: 1, generic: ['技术'], keywords: ['coo', '代码'], status: 'weak' }),
    JSON.stringify({ turn: 2, seqStart: 2, seqEnd: 2, generic: ['游戏'], keywords: ['coo', '跑团'], status: 'weak' }),
  ].join('\n'));
  const tool = createRecallTool({ file });
  const result = JSON.parse(await tool.execute({ query: 'Coo 技术' }));
  assert.equal(result.ok, true);
  assert.equal(result.via, 'K');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].turn, 1);
});

test('recall with no query interprets the current user message', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recall-tool-')), 'index.jsonl');
  fs.writeFileSync(file, '');
  const events = [
    { type: 'user/message', seq: 56503, data: { turn: 600, content: [{ type: 'text', text: '我们来回忆一下上次跑团的内容' }] } },
  ];
  const tool = createRecallTool({ file, sessionQuery: { readSession: async () => ({ events }) } });
  const result = JSON.parse(await tool.execute({}, { agent: { session: { id: 's' }, lastTurn: 601 } }));
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'locate');
  assert.equal(result.via, 'live');
  assert.equal(result.candidates[0].turn, 600);
});

test('label directives return inventories', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recall-tool-')), 'index.jsonl');
  const cmapFile = path.join(path.dirname(file), 'cmap.md');
  fs.writeFileSync(cmapFile, '跑团 => 游戏 / 故事 / 对话\n');
  fs.writeFileSync(file, JSON.stringify({ turn: 1, seqStart: 1, seqEnd: 1, generic: ['技术'], keywords: ['coo'], terms: ['跑团'] }) + '\n');
  const tool = createRecallTool({ file, cmapFile });
  const b = JSON.parse(await tool.execute({ query: 'B标签' }));
  assert.equal(b.mode, 'labels');
  assert.equal(b.kind, 'B');
  assert.equal(b.labels[0].label, '技术');
  const k = JSON.parse(await tool.execute({ query: 'K标签' }));
  assert.equal(k.kind, 'K');
  assert.equal(k.labels.some((row) => row.label === 'Coo'), true);
  const c = JSON.parse(await tool.execute({ query: 'C标签' }));
  assert.equal(c.kind, 'C');
  assert.equal(c.labels[0].label, '跑团');
});
