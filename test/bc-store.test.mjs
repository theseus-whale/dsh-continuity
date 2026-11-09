import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defaultBCStorePath, emptyStore, loadBCStore, saveBCStore } from '../src/memory/bc-store.mjs';
import { learnTerm, makeRecord } from '../src/memory/bc-recall.mjs';

test('store roundtrip keeps records and C map', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-store-')), 'store.json');
  const store = emptyStore();
  store.records.push(makeRecord({ turn: 40, seqStart: 1, seqEnd: 2, text: '灯', generic: ['游戏'], terms: ['跑团'] }));
  learnTerm(store.cmap, '跑团', ['游戏', '故事']);
  saveBCStore(file, store);
  const loaded = loadBCStore(file);
  assert.equal(loaded.records.length, 1);
  assert.equal(loaded.records[0].turn, 40);
  assert.deepEqual(loaded.cmap.terms.get('跑团'), ['游戏', '故事']);
});

test('missing store is empty', () => {
  const store = loadBCStore(path.join(os.tmpdir(), 'does-not-exist-bc-store.json'));
  assert.equal(store.records.length, 0);
  assert.equal(store.cmap.terms.size, 0);
});

test('default store path is per home', () => {
  assert.equal(defaultBCStorePath('C:\\u\\a'), path.join('C:\\u\\a', '.dsh', 'continuity', 'bc-index.jsonl'));
  assert.notEqual(defaultBCStorePath('C:\\u\\a'), defaultBCStorePath('C:\\u\\b'));
});
