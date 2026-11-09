import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEventSummaryTree, verifyEventSummaryTree } from '../src/memory/event-summary-tree.mjs';

const records = [
  { turn: 1, seqStart: 10, seqEnd: 10, text: '推门进灯室', hash: 'h1' },
  { turn: 2, seqStart: 20, seqEnd: 20, text: '看见外套', hash: 'h2' },
  { turn: 3, seqStart: 30, seqEnd: 30, text: '去钟楼', hash: 'h3' },
  { turn: 4, seqStart: 40, seqEnd: 40, text: '敲钟', hash: 'h4' },
  { turn: 5, seqStart: 50, seqEnd: 50, text: '回矿口', hash: 'h5' },
  { turn: 6, seqStart: 60, seqEnd: 60, text: '交货', hash: 'h6' },
];
const eventIds = { 1: 'e1', 2: 'e1', 3: 'e2', 4: 'e2', 5: 'e3', 6: 'e3' };

test('segments are event groups, not fixed-size windows', () => {
  const tree = buildEventSummaryTree(records, { eventIds, chapterSize: 2 });
  assert.equal(tree.levels.turn, 6);
  assert.equal(tree.levels.segment, 3);
  assert.equal(tree.levels.chapter, 2);
  assert.equal(verifyEventSummaryTree(tree).ok, true);
  const segments = tree.nodes.filter((node) => node.level === 'segment');
  assert.deepEqual(segments.map((node) => node.eventId), ['e1', 'e2', 'e3']);
  assert.deepEqual(segments[0].childIds, ['turn-00001', 'turn-00002']);
});

test('no segment crosses an event boundary', () => {
  const tree = buildEventSummaryTree(records, { eventIds, chapterSize: 2 });
  for (const segment of tree.nodes.filter((node) => node.level === 'segment')) {
    const childEvents = new Set(segment.childIds.map((id) => tree.nodes.find((node) => node.id === id).eventId));
    assert.equal(childEvents.size, 1);
    assert.equal(childEvents.has(segment.eventId), true);
  }
});

test('event tree rebuild is deterministic', () => {
  const a = buildEventSummaryTree(records, { eventIds, chapterSize: 2 });
  const b = buildEventSummaryTree(records, { eventIds, chapterSize: 2 });
  assert.equal(a.treeRootHash, b.treeRootHash);
  assert.deepEqual(a.nodes, b.nodes);
});
