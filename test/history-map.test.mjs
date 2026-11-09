import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHistoryMap } from '../src/memory/history-map.mjs';

const summaryEvent = (seq, start, end, text) => ({
  seq,
  type: 'compaction/summary',
  time: 1_700_000_000_000 + seq,
  data: { shadowedRange: { start, end }, summary: [{ type: 'text', text }] },
});

test('history map has marker, coverage and source disclaimer', () => {
  const index = {
    sessionId: 's',
    generatedAt: '2026-11-06T00:00:00.000Z',
    maxSummarySeq: 10,
    coveredThroughSeq: 8,
    coverage: { minSeq: 1, maxSeq: 8 },
    records: [
      { fromSeq: 1, toSeq: 8, text: 'old checkpoint about memory' },
    ],
  };
  const map = buildHistoryMap({ index, events: [], maxTokens: 4000 });
  assert.ok(map.text.startsWith('[continuity:history-map]'));
  assert.match(map.text, /raw session_log/);
  assert.equal(map.maxSummarySeq, 10);
  assert.ok(map.approxTokens <= 4000);
});

test('history map includes folds newer than the archive index', () => {
  const index = { sessionId: 's', maxSummarySeq: 10, coveredThroughSeq: 8, coverage: {}, records: [] };
  const events = [summaryEvent(12, 9, 12, '[gist] newly folded')];
  const map = buildHistoryMap({ index, events, maxTokens: 4000 });
  assert.match(map.text, /newly folded/);
  assert.equal(map.extraFolds, 1);
  assert.equal(map.latestRawSummarySeq, 12);
});
