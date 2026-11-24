import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryRelatedTool, resolveRelatedAnchor } from '../src/fullseed/memory-related-tool.mjs';
import { buildChunkTimeline } from '../src/fullseed/continuation-shadow.mjs';
import { activate, writeBase, writeDelta } from '../src/fullseed/storage.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(testDir, '.tmp-memory-related-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const summaries = [];
  const vectors = [];
  for (let index = 0; index < 12; index += 1) {
    const vector = index === 0 || index === 5 || index === 6 ? [1, 0]
      : index === 2 ? [0.9, 0.1]
        : [0, 1];
    summaries.push({
      chunkId: `chunk-${index}`,
      turnId: `turn-${String(index).padStart(6, '0')}`,
      chunkIndex: 0,
      seqStart: index * 10 + 1,
      seqEnd: index * 10 + 3,
      summaryText: `摘要 ${index}`,
      summarySha256: `summary-${index}`,
      concreteNouns: [],
    });
    vectors.push(vector);
  }
  writeBase(root, { baseId: 'base', summaries, vectors, identity: 'test', checkpoint: 113, snapshotBoundary: 113 });
  activate(root, { baseId: 'base', identity: 'test', checkpoint: 113, snapshotBoundary: 113 });
  return { root, summaries, vectors };
}

test('memory_related defaults to next five summary chunks and returns the strongest, not nearest', async (t) => {
  const { root } = fixture(t);
  const tool = createMemoryRelatedTool({ resolveRoot: () => root });
  const result = JSON.parse(await tool.execute({ turnId: 'turn-000000' }));
  assert.equal(result.direction, 'next');
  assert.equal(result.window, 5);
  assert.equal(result.candidateCount, 5);
  assert.equal(result.selected.chunkId, 'chunk-5');
  assert.equal(result.selected.ordinalGap, 5);
  assert.equal(result.anchor.turnId, 'turn-000000');
  assert.equal(result.selected.rawText, undefined);
  assert.deepEqual(result.candidates.map((candidate) => candidate.chunkId), ['chunk-5', 'chunk-2', 'chunk-1']);
  assert.equal(result.candidates[0].chunkId, result.selected.chunkId);
  assert.ok(result.candidates[0].cosine >= result.candidates[1].cosine);
  assert.ok(result.candidates[1].cosine >= result.candidates[2].cosine);
  for (const candidate of result.candidates) {
    assert.equal(candidate.summaryText, undefined);
    assert.equal(candidate.rawText, undefined);
  }
});

test('a negative window searches previous chunks and is bounded by its absolute value', async (t) => {
  const { root } = fixture(t);
  const tool = createMemoryRelatedTool({ resolveRoot: () => root });
  const result = JSON.parse(await tool.execute({ chunkId: 'chunk-6', window: -2 }));
  assert.equal(result.direction, 'prev');
  assert.equal(result.window, 2);
  assert.equal(result.candidateCount, 2);
  assert.equal(result.selected.chunkId, 'chunk-5');
  assert.equal(result.selected.ordinalGap, 1);
  assert.deepEqual(result.candidates.map((candidate) => candidate.chunkId), ['chunk-5', 'chunk-4']);
});

test('anchor nav returns both chronological neighbors without summaries and independently of search direction', async (t) => {
  const { root } = fixture(t);
  const tool = createMemoryRelatedTool({ resolveRoot: () => root });
  const result = JSON.parse(await tool.execute({ chunkId: 'chunk-6', window: -2 }));
  assert.deepEqual(result.nav, {
    prev: { chunkId: 'chunk-5', turnId: 'turn-000005', chunkIndex: 0, seqStart: 51, seqEnd: 53 },
    next: { chunkId: 'chunk-7', turnId: 'turn-000007', chunkIndex: 0, seqStart: 71, seqEnd: 73 },
  });
  assert.equal(result.nav.prev.summaryText, undefined);
  assert.equal(result.nav.next.summaryText, undefined);
  const first = JSON.parse(await tool.execute({ chunkId: 'chunk-0' }));
  const last = JSON.parse(await tool.execute({ chunkId: 'chunk-11' }));
  assert.equal(first.nav.prev, null);
  assert.equal(first.nav.next.chunkId, 'chunk-1');
  assert.equal(last.nav.prev.chunkId, 'chunk-10');
  assert.equal(last.nav.next, null);
});

test('seq resolves the summary chunk containing it and boundaries return no selection', async (t) => {
  const { root } = fixture(t);
  const tool = createMemoryRelatedTool({ resolveRoot: () => root });
  const bySeq = JSON.parse(await tool.execute({ seq: 52, window: 1 }));
  assert.equal(bySeq.anchor.chunkId, 'chunk-5');
  assert.equal(bySeq.selected.chunkId, 'chunk-6');
  assert.deepEqual(bySeq.candidates.map((candidate) => candidate.chunkId), ['chunk-6']);
  const boundary = JSON.parse(await tool.execute({ chunkId: 'chunk-0', window: -5 }));
  assert.equal(boundary.candidateCount, 0);
  assert.equal(boundary.selected, null);
  assert.deepEqual(boundary.candidates, []);
});

test('window rejects zero and values beyond the measured twenty-block bound', async (t) => {
  const { root } = fixture(t);
  const tool = createMemoryRelatedTool({ resolveRoot: () => root });
  await assert.rejects(() => tool.execute({ chunkId: 'chunk-0', window: 0 }), /nonzero integer/);
  await assert.rejects(() => tool.execute({ chunkId: 'chunk-0', window: 21 }), /nonzero integer/);
});

test('natural turns with multiple chunks require chunkIndex instead of silently choosing', () => {
  const summaries = [
    { chunkId: 'a', turnId: 'turn-000337', chunkIndex: 0, seqStart: 337, seqEnd: 337, summaryText: '前半' },
    { chunkId: 'b', turnId: 'turn-000337', chunkIndex: 1, seqStart: 337, seqEnd: 337, summaryText: '后半' },
  ];
  const timeline = buildChunkTimeline(summaries, [[1, 0], [0, 1]]);
  assert.throws(() => resolveRelatedAnchor(timeline, { turnId: 'turn-000337' }), /multiple summary chunks/);
  assert.throws(() => resolveRelatedAnchor(timeline, { seq: 337 }), /multiple summary chunks/);
  assert.equal(resolveRelatedAnchor(timeline, { turnId: 'turn-000337', chunkIndex: 1 }).chunkId, 'b');
  assert.equal(resolveRelatedAnchor(timeline, { seq: 337, chunkIndex: 0 }).chunkId, 'a');
});

test('execute ignores an exact physical duplicate already present in an overlapping delta', async (t) => {
  const { root, summaries, vectors } = fixture(t);
  writeDelta(root, {
    baseId: 'base', deltaId: 'overlap', summaries: [summaries[5]], vectors: [vectors[5]],
    fromCheckpoint: 113, toCheckpoint: 113, identity: 'test',
  });
  activate(root, { baseId: 'base', deltaIds: ['overlap'], identity: 'test', checkpoint: 113, snapshotBoundary: 113 });
  const tool = createMemoryRelatedTool({ resolveRoot: () => root });
  const result = JSON.parse(await tool.execute({ chunkId: 'chunk-0' }));
  assert.equal(result.candidateCount, 5);
  assert.equal(result.selected.chunkId, 'chunk-5');
  assert.deepEqual(result.candidates.map((candidate) => candidate.chunkId), ['chunk-5', 'chunk-2', 'chunk-1']);
});

test('execute rejects a duplicate chunkId with conflicting summary content', async (t) => {
  const { root, summaries, vectors } = fixture(t);
  const conflicting = { ...summaries[5], summaryText: '被改写', summarySha256: 'different-summary' };
  writeDelta(root, {
    baseId: 'base', deltaId: 'conflict', summaries: [conflicting], vectors: [vectors[5]],
    fromCheckpoint: 113, toCheckpoint: 113, identity: 'test',
  });
  activate(root, { baseId: 'base', deltaIds: ['conflict'], identity: 'test', checkpoint: 113, snapshotBoundary: 113 });
  const tool = createMemoryRelatedTool({ resolveRoot: () => root });
  await assert.rejects(() => tool.execute({ chunkId: 'chunk-0' }), /conflicting active chunkId chunk-5/);
});

test('execute rejects a duplicate chunkId with a conflicting vector', async (t) => {
  const { root, summaries } = fixture(t);
  writeDelta(root, {
    baseId: 'base', deltaId: 'conflict', summaries: [summaries[5]], vectors: [[0.8, 0.2]],
    fromCheckpoint: 113, toCheckpoint: 113, identity: 'test',
  });
  activate(root, { baseId: 'base', deltaIds: ['conflict'], identity: 'test', checkpoint: 113, snapshotBoundary: 113 });
  const tool = createMemoryRelatedTool({ resolveRoot: () => root });
  await assert.rejects(() => tool.execute({ chunkId: 'chunk-0' }), /conflicting active chunkId chunk-5/);
});

test('tool schema teaches short anchors, ranked candidates, and every signed window value', () => {
  const tool = createMemoryRelatedTool({ resolveRoot: () => '' });
  for (const marker of ['memory_recall', 'turnId or seq', 'chunkIndex or chunkId', 'read_seq_range', 'defaults to 5', '1..20', '-1..-20', '0 is invalid', 'anchor nav', 'up to three ranked candidates', 'nav answers chronological order']) {
    assert.ok(tool.description.includes(marker), `description missing ${marker}`);
  }
  assert.equal(tool.parameters.properties.window.minimum, -20);
  assert.equal(tool.parameters.properties.window.maximum, 20);
  assert.match(tool.parameters.properties.window.description, /zero is invalid/);
});
