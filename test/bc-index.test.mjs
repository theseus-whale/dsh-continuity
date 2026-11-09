import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadIndexJsonl, saveIndexJsonl, toPointer } from '../src/memory/bc-index.mjs';
import { makeRecord } from '../src/memory/bc-recall.mjs';

test('pointer index omits raw text and roundtrips', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-index-')), 'index.jsonl');
  const record = makeRecord({
    turn: 40,
    seqStart: 1,
    seqEnd: 2,
    text: 'raw secret',
    generic: ['游戏'],
    terms: ['跑团'],
    conceptScores: { 游戏: 0.5 },
    topicMinScore: 0.33,
    labelStamp: 'abc123def456',
  });
  const pointer = toPointer(record);
  assert.equal('text' in pointer, false);
  assert.equal(pointer.topicMinScore, 0.33);
  assert.equal(pointer.labelStamp, 'abc123def456');
  assert.deepEqual(pointer.terms, ['跑团']);
  saveIndexJsonl(file, [record]);
  const loaded = loadIndexJsonl(file);
  assert.deepEqual(loaded, [pointer]);
});
