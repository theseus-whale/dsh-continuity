import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createIndexUpdater } from '../src/memory/bc-index-updater.mjs';
import { loadIndexJsonl } from '../src/memory/bc-index.mjs';

test('index updater appends one B record per completed turn', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-updater-')), 'bc-index.jsonl');
  fs.writeFileSync(file, '');
  const events = [
    { type: 'user/message', seq: 101, data: { turn: 1, content: [{ type: 'text', text: '跑团开始' }] } },
    { type: 'user/message', seq: 103, data: { turn: 2, content: [{ type: 'text', text: '继续跑团' }] } },
    { type: 'user/message', seq: 105, data: { turn: 3, content: [{ type: 'text', text: '还在跑团' }] } },
  ];
  const labeler = { label: async () => ({ candidates: [{ concept: '游戏', score: 0.9 }], top: { concept: '游戏', score: 0.9 } }) };
  const updater = createIndexUpdater({
    file,
    labeler,
    maxPerRun: 2,
    sessionQuery: { readSession: async () => ({ events }) },
  });
  const first = await updater({ agent: { session: { id: 's' } }, lastTurn: 3 });
  assert.equal(first.added, 2);
  assert.equal(loadIndexJsonl(file).at(-1).turn, 2);
  const second = await updater({ agent: { session: { id: 's' } }, lastTurn: 4 });
  assert.equal(second.added, 1);
  assert.equal(loadIndexJsonl(file).at(-1).turn, 3);
});

test('updater maps turn markers to user messages and drops reasoning', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-updater-')), 'bc-index.jsonl');
  fs.writeFileSync(file, '');
  const events = [
    { type: 'turn/start', seq: 100, data: { turn: 1 } },
    { type: 'user/message', seq: 101, data: { content: [{ type: 'text', text: '用户说跑团' }] } },
    { type: 'assistant/message', seq: 102, data: { turn: 1, content: [
      { type: 'text', text: '助手回答' },
      { type: 'reasoning', text: 'HIDDEN_REASONING' },
    ] } },
    { type: 'turn/start', seq: 200, data: { turn: 2 } },
    { type: 'user/message', seq: 201, data: { content: [{ type: 'text', text: '用户说矢量' }] } },
  ];
  const seen = [];
  const labeler = {
    label: async (text) => {
      seen.push(text);
      return { candidates: [{ concept: '游戏', score: 0.9 }], top: { concept: '游戏', score: 0.9 } };
    },
  };
  const updater = createIndexUpdater({
    file,
    labeler,
    maxPerRun: 5,
    sessionQuery: { readSession: async () => ({ events }) },
  });
  const result = await updater({ agent: { session: { id: 's' } }, lastTurn: 3 });
  assert.equal(result.added, 2);
  const records = loadIndexJsonl(file);
  assert.equal(records[0].turn, 1);
  assert.equal(seen.length, 2);
  assert.match(seen[0], /用户说跑团/);
  assert.match(seen[0], /助手回答/);
  assert.doesNotMatch(seen[0], /HIDDEN_REASONING/);
  assert.match(seen[0], /用户说跑团[\s\S]*助手回答/);
});

test('updater records C-map terms and keeps empty terms as an array', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-updater-'));
  const file = path.join(dir, 'bc-index.jsonl');
  const cmapFile = path.join(dir, 'cmap.md');
  fs.writeFileSync(file, '');
  fs.writeFileSync(cmapFile, '跑团 => 游戏\n');
  const events = [
    { type: 'user/message', seq: 101, data: { turn: 1, content: [{ type: 'text', text: '今晚跑团' }] } },
    { type: 'user/message', seq: 103, data: { turn: 2, content: [{ type: 'text', text: '随便聊聊' }] } },
  ];
  const labeler = { label: async () => ({ candidates: [], top: null }) };
  const updater = createIndexUpdater({
    file,
    cmapFile,
    labeler,
    maxPerRun: 5,
    sessionQuery: { readSession: async () => ({ events }) },
  });
  const result = await updater({ agent: { session: { id: 's' } }, lastTurn: 3 });
  assert.equal(result.added, 2);
  const records = loadIndexJsonl(file);
  assert.deepEqual(records[0].terms, ['跑团']);
  assert.deepEqual(records[1].terms, []);
});
