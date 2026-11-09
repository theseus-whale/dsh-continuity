import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSummaryIndex, querySummaryIndex, summaryIndexStaleness } from '../src/memory/summary-index.mjs';

function event(seq, type, data = {}) {
  return { seq, type, time: 1_700_000_000_000 + seq, data };
}

test('indexes gist + checkpoint and plans a gap', () => {
  const events = [
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'compaction/summary', {
      shadowedRange: { start: 1, end: 2 },
      shadowedTokenCount: 100,
      summary: [{ type: 'text', text: '[gist · log:session#seq=1-2 · 2 messages]' }],
    }),
    event(3, 'turn/start', { turn: 2 }),
    event(4, 'compaction/summary', {
      shadowedRange: { start: 3, end: 4 },
      shadowedTokenCount: 200,
      summary: [{ type: 'text', text: '## Primary Request and Intent\n- checkpoint' }],
    }),
    event(5, 'turn/start', { turn: 3 }),
    event(6, 'user/message', { content: [{ type: 'text', text: 'x'.repeat(4000) }] }),
  ];
  const index = buildSummaryIndex({ sessionId: 's', events, windowTokens: 100 });
  assert.equal(index.records.length, 2);
  assert.equal(index.records[0].kind, 'gist');
  assert.equal(index.records[1].kind, 'checkpoint');
  assert.equal(index.records[0].fromTurn, 1);
  assert.equal(index.records[1].toTurn, 2);
  assert.equal(index.pendingWindows.length, 1);
  assert.equal(index.pendingWindows[0].fromSeq, 5);
  assert.equal(index.pendingWindows[0].toSeq, 6);
  assert.ok(index.coverage.sourceTokens > 0);
});

test('deduplicates identical summary records', () => {
  const summary = {
    shadowedRange: { start: 1, end: 2 },
    shadowedTokenCount: 100,
    summary: [{ type: 'text', text: '[gist · same]' }],
  };
  const index = buildSummaryIndex({
    sessionId: 's',
    events: [event(1, 'turn/start', { turn: 1 }), event(2, 'compaction/summary', summary), event(2, 'compaction/summary', summary)],
    windowTokens: 100,
  });
  assert.equal(index.records.length, 1);
});

test('tracks max summary seq and detects staleness', () => {
  const events = [
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'compaction/summary', {
      shadowedRange: { start: 1, end: 2 },
      summary: [{ type: 'text', text: '[gist · 记忆宫殿]' }],
    }),
  ];
  const index = buildSummaryIndex({ sessionId: 's', events, windowTokens: 100 });
  assert.equal(index.maxSummarySeq, 2);
  assert.equal(index.coverage.sourceTokensBasis, 'dedup-merged-ranges');
  assert.equal(summaryIndexStaleness(index, [{ seqEnd: 2 }]).stale, false);
  assert.equal(summaryIndexStaleness(index, [{ seqEnd: 3 }]).stale, true);
  const hit = querySummaryIndex(index, '记忆宫殿');
  assert.equal(hit.total, 1);
  assert.equal(hit.hits[0].id, 's-1-2');
});

test('missing maxSummarySeq is stale, not fresh', () => {
  const legacy = { records: [], maxSummarySeq: undefined };
  const result = summaryIndexStaleness(legacy, [{ seqEnd: 1 }]);
  assert.equal(result.stale, true);
  assert.equal(result.staleBy, null);
  assert.equal(result.maxSummarySeq, null);
});

test('index ahead of raw is stale, with negative staleBy', () => {
  const result = summaryIndexStaleness({ maxSummarySeq: 5 }, [{ seqEnd: 2 }], { latestSummarySeq: 2 });
  assert.equal(result.stale, true);
  assert.equal(result.staleBy, -3);
});

test('bootstrap replace ranges close archive gaps', () => {
  const events = [
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'compaction/summary', {
      shadowedRange: { start: 1, end: 2 },
      summary: [{ type: 'text', text: '[gist · covered]' }],
    }),
    event(3, 'user/message', { content: [{ type: 'text', text: 'x'.repeat(4000) }] }),
    event(4, 'assistant/message', { content: [{ type: 'text', text: 'y'.repeat(4000) }] }),
  ];
  const index = buildSummaryIndex({
    sessionId: 's',
    events,
    windowTokens: 100,
    bootstrapRanges: [{ fromSeq: 3, toSeq: 4, tokens: 2000, carrierSeq: 5 }],
  });
  assert.equal(index.pendingWindows.length, 0);
  assert.equal(index.bootstrapRanges.length, 1);
  assert.equal(index.coverage.bootstrap, 1);
});

test('extracted window ranges close archive gaps', () => {
  const events = [
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'compaction/summary', {
      shadowedRange: { start: 1, end: 2 },
      summary: [{ type: 'text', text: '[gist · covered]' }],
    }),
    event(3, 'user/message', { content: [{ type: 'text', text: 'x'.repeat(4000) }] }),
    event(4, 'assistant/message', { content: [{ type: 'text', text: 'y'.repeat(4000) }] }),
  ];
  const window = { fromSeq: 3, toSeq: 4, text: 'window needle', hash: 'abc', approxTokens: 400 };
  const index = buildSummaryIndex({
    sessionId: 's',
    events,
    windowTokens: 100,
    windowRanges: [{ fromSeq: 3, toSeq: 4, tokens: 400, hash: 'abc' }],
    windowRecords: [window],
  });
  assert.equal(index.pendingWindows.length, 0);
  assert.equal(index.windowRanges.length, 1);
  assert.equal(index.coverage.windows, 1);
  assert.equal(index.records.length, 2);
  const hit = querySummaryIndex(index, 'needle');
  assert.equal(hit.total, 1);
  assert.equal(hit.hits[0].kind, 'window-extractive');
  assert.equal(hit.hits[0].quality, 'extractive');
});


