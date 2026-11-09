import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildBCPanelState } from '../src/memory/bc-panel-state.mjs';

test('BC panel counts generic and special labels', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-panel-'));
  const file = path.join(dir, 'bc-index.jsonl');
  const keywordsFile = path.join(dir, 'keywords.md');
  const cmapFile = path.join(dir, 'cmap.md');
  const conceptsFile = path.join(dir, 'concepts.md');
  fs.writeFileSync(keywordsFile, 'Coo\nContinuity\n');
  fs.writeFileSync(cmapFile, '跑团 => 游戏 / 故事 / 对话\n折叠 => 上下文压缩\n空词 => 游戏\n');
  fs.writeFileSync(conceptsFile, '游戏 | 游戏、桌游 | 2\n故事 | 故事、剧情 | 2\n');
  fs.writeFileSync(file, [
    JSON.stringify({ turn: 1, generic: ['游戏', '故事'], terms: ['跑团'], keywords: ['coo'], status: 'weak' }),
    JSON.stringify({ turn: 2, generic: ['游戏'], terms: ['跑团'], keywords: ['coo', 'continuity'], status: 'confirmed' }),
    JSON.stringify({ turn: 3, generic: ['游戏'], terms: [], keywords: ['折叠'], conceptScores: { 上下文压缩: 0.8 }, status: 'confirmed' }),
  ].join('\n'));
  const state = buildBCPanelState({ file, keywordsFile, cmapFile, conceptsFile });
  assert.equal(state.available, true);
  assert.equal(state.totalTurns, 3);
  assert.equal(state.firstTurn, 1);
  assert.equal(state.lastTurn, 3);
  assert.equal(typeof state.updatedAt, 'string');
  assert.equal(state.weakTurns, 1);
  assert.deepEqual(state.labels[0], { label: '游戏', turns: 3 });
  const game = state.aLabels.find((row) => row.label === '游戏');
  assert.equal(game.coverage, 2);
  assert.equal(game.turns, 3);
  assert.deepEqual(state.kLabels, [
    { label: 'Coo', turns: 2 },
    { label: 'Continuity', turns: 1 },
  ]);
  assert.deepEqual(state.cLabels, [{
    label: '跑团',
    turns: 2,
    concepts: ['游戏', '故事', '对话'],
    keywords: [],
    minB: 0,
    limit: 20,
    summary: '',
  }, {
    label: '折叠',
    turns: 1,
    concepts: ['上下文压缩'],
    keywords: [],
    minB: 0,
    limit: 20,
    summary: '',
  }, {
    label: '空词',
    turns: 0,
    concepts: ['游戏'],
    keywords: [],
    minB: 0,
    limit: 20,
    summary: '',
  }]);
});
