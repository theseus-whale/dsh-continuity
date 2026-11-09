import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildEventLog, verifyEventLog, writeEventLog, appendEvent, readEventLog } from '../src/memory/event-log.mjs';
import { BM25Index } from '../src/memory/bm25.mjs';
import { buildSummaryTree, verifySummaryTree } from '../src/memory/summary-tree.mjs';
import { VectorIndex } from '../src/memory/vector-index.mjs';
import { reciprocalRankFusion } from '../src/memory/planner.mjs';

const rows = [
  { turn: 1, seqStart: 10, seqEnd: 10, text: '骰子 d100 钥匙 灯室', facets: { activity: '跑团' }, labelSource: 'test' },
  { turn: 2, seqStart: 20, seqEnd: 20, text: 'TAG 闸 上下文 折叠', facets: { activity: '调试' }, labelSource: 'test' },
  { turn: 3, seqStart: 30, seqEnd: 30, text: '跑团 灯室 剧情', facets: { activity: '跑团' }, labelSource: 'test' },
];

test('event log is append-only and verifies its chain', () => {
  const records = buildEventLog(rows);
  const verification = verifyEventLog(records);
  assert.equal(verification.ok, true);
  assert.equal(verification.count, 3);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-log-'));
  const file = path.join(dir, 'events.jsonl');
  try {
    const written = writeEventLog(file, records);
    assert.equal(written.rootHash, verification.rootHash);
    assert.deepEqual(readEventLog(file), records);
    const appended = appendEvent(file, { turn: 4, seqStart: 40, seqEnd: 40, text: 'new', facets: {} });
    assert.equal(appended.prevHash, verification.rootHash);
    const reread = readEventLog(file);
    assert.equal(verifyEventLog(reread).ok, true);
    assert.equal(reread.length, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('event log detects tampering', () => {
  const records = buildEventLog(rows);
  records[1].text = 'tampered';
  assert.equal(verifyEventLog(records).ok, false);
});

test('BM25 finds run turns and technical turns', () => {
  const records = buildEventLog(rows);
  const index = new BM25Index().build(records);
  const run = index.search('d100 钥匙', { topK: 2 });
  assert.equal(run[0].turn, 1);
  const technical = index.search('TAG 闸', { topK: 2 });
  assert.equal(technical[0].turn, 2);
  const restored = BM25Index.fromJSON(index.toJSON());
  assert.ok([1, 3].includes(restored.search('灯室', { topK: 2 })[0].turn));
});

test('summary tree is deterministic and points back to seq ranges', () => {
  const records = buildEventLog(rows);
  const tree = buildSummaryTree(records, { segmentSize: 2, chapterSize: 2 });
  assert.equal(verifySummaryTree(tree).ok, true);
  assert.equal(tree.levels.turn, 3);
  assert.equal(tree.levels.segment, 2);
  assert.equal(tree.levels.chapter, 1);
  const segment = tree.nodes.find((node) => node.level === 'segment');
  assert.equal(segment.seqStart, 10);
  assert.equal(segment.seqEnd, 20);
  assert.deepEqual(segment.childIds, ['turn-00001', 'turn-00002']);
  const rebuilt = buildSummaryTree(records, { segmentSize: 2, chapterSize: 2 });
  assert.equal(rebuilt.treeRootHash, tree.treeRootHash);
});

test('vector search and reciprocal rank fusion work', () => {
  const index = new VectorIndex();
  index.docs = [
    { turn: 1, seqStart: 10, seqEnd: 10, vector: [1, 0] },
    { turn: 2, seqStart: 20, seqEnd: 20, vector: [0, 1] },
  ];
  assert.equal(index.search([1, 0], { topK: 1 })[0].turn, 1);
  const fused = reciprocalRankFusion({
    bm25: [{ turn: 2, seqStart: 20, seqEnd: 20 }],
    vector: [{ turn: 1, seqStart: 10, seqEnd: 10 }],
  });
  assert.equal(fused.length, 2);
  assert.ok(fused[0].sources.bm25 !== undefined || fused[0].sources.vector !== undefined);
});
