import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBackfillSegment,
  rangeOverlaps,
  selectBackfillEvents,
  trimBackfillEvents,
} from '../src/backfill.mjs';
import { normalizeThread } from '../src/threads.mjs';

const ev = (seq, type, text = '') => ({
  seq,
  type,
  time: 1000 + seq,
  ...(type === 'user/message'
    ? { data: { content: [{ type: 'text', text }], source: { kind: 'user' } } }
    : { data: {} }),
});

test('selectBackfillEvents keeps only content whitelist entries in range', () => {
  const events = [
    ev(1, 'step/start'),
    ev(2, 'user/message', 'u'),
    ev(3, 'tool/call'),
    ev(4, 'tool/result'),
    ev(5, 'turn/end'),
  ];
  assert.deepEqual(selectBackfillEvents(events, 2, 4).map((row) => row.seq), [2, 3, 4]);
});

test('trimBackfillEvents drops a leading result and trailing call', () => {
  const events = [ev(1, 'tool/result'), ev(2, 'user/message', 'u'), ev(3, 'tool/call')];
  assert.deepEqual(trimBackfillEvents(events).map((row) => row.seq), [2]);
});

test('buildBackfillSegment uses content boundaries and estimates tokens', () => {
  const segment = buildBackfillSegment(
    [ev(10, 'user/message', 'hello'), ev(11, 'assistant/message', 'world')],
    { sessionId: 's', why: 'w', next: 'n', tCoverage: 'T14' },
  );
  assert.equal(segment.fromSeq, 10);
  assert.equal(segment.toSeq, 11);
  assert.deepEqual(segment.seqs, [10, 11]);
  assert.equal(segment.count, 2);
  assert.equal(segment.tCoverage, 'T14');
  assert.match(segment.archiveRef, /#seq=10-11$/);
  assert.equal(segment.at, segment.spanEnd);
  assert.match(segment.archivedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('rangeOverlaps is inclusive and strict', () => {
  const segments = [{ fromSeq: 10, toSeq: 20 }];
  assert.equal(rangeOverlaps(segments, 20, 30), true);
  assert.equal(rangeOverlaps(segments, 21, 30), false);
  assert.equal(rangeOverlaps(segments, 1, 9), false);
});

test('normalizeThread sorts an appended backfill segment and keeps latest metadata', () => {
  const thread = normalizeThread({
    id: 't',
    label: 'T',
    updatedAt: '2026-02-01T00:00:00.000Z',
    segments: [
      { fromSeq: 100, toSeq: 200, why: 'latest', next: 'next', spanStart: '2026-01-01T00:00:00.000Z', spanEnd: '2026-01-01T00:10:00.000Z' },
      { fromSeq: 10, toSeq: 20, why: '历史回补 10..20', next: 'old', at: '2026-02-01T00:00:00.000Z', spanStart: '2025-12-31T00:00:00.000Z', spanEnd: '2025-12-31T00:10:00.000Z' },
    ],
  });
  assert.deepEqual(thread.segments.map((segment) => segment.fromSeq), [10, 100]);
  assert.equal(thread.seqStart, 10);
  assert.equal(thread.seqEnd, 200);
  assert.equal(thread.segments[0].at, '2025-12-31T00:10:00.000Z');
  assert.equal(thread.segments[0].archivedAt, '2026-02-01T00:00:00.000Z');
  assert.equal(thread.why, 'latest');
  assert.equal(thread.next, 'next');
  assert.equal(thread.updatedAt, '2026-01-01T00:10:00.000Z');
});
