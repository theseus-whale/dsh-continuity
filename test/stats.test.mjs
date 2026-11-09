import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStats, classifyStatsEvent, tailSeqs } from '../src/session-log.mjs';
import { createSessionLogTool } from '../src/session-log-tool.mjs';
import { continuityState } from '../src/state.mjs';

const text = (value) => [{ type: 'text', text: value }];
const events = [
  { seq: 1, type: 'system/message', data: { message: { role: 'system', content: text('S'.repeat(100)) } } },
  { seq: 2, type: 'user/message', data: { content: text('U'.repeat(40)) } },
  { seq: 3, type: 'assistant/message', data: { message: { role: 'assistant', content: [
    { type: 'reasoning', text: 'R'.repeat(600) },
    { type: 'text', text: 'A'.repeat(30) },
    { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' },
  ] } } },
  { seq: 4, type: 'tool/result', data: { message: { role: 'tool', source: { callId: 'call-1' }, content: text('T'.repeat(200)) } } },
  { seq: 5, type: 'tool/call', data: { callId: 'call-1', turn: 1, name: 'read', arguments: '{}' } },
  { seq: 6, type: 'compaction/summary', data: { summary: text('G'.repeat(50)) } },
];

test('classifyStatsEvent separates reasoning, assistant text and tool-call args', () => {
  const rows = new Map(classifyStatsEvent(events[2]).map((row) => [row.category, row.chars]));
  assert.equal(rows.get('reasoning'), 600);
  assert.equal(rows.get('assistant_text'), 30);
  assert.equal(rows.get('tool_call'), 6);
  assert.equal(classifyStatsEvent(events[4]).length, 0);
});

test('buildStats aggregates chars and splits node tokens by category chars', () => {
  const plain = buildStats(events);
  assert.equal(plain.totalChars, 1026);
  assert.equal(Math.round(plain.totalTokens), 257);
  const by = new Map(plain.rows.map((row) => [row.category, row]));
  assert.equal(by.get('reasoning').chars, 600);
  assert.equal(by.get('tool_result').chars, 200);
  assert.equal(by.get('gist').chars, 50);

  const tokensBySeq = new Map([[1, 20], [2, 10], [3, 160], [4, 50], [5, 0], [6, 0]]);
  const priced = buildStats(events, { tokensBySeq });
  assert.equal(priced.totalTokens, 240);
  const p = new Map(priced.rows.map((row) => [row.category, row]));
  assert.equal(p.get('tool_result').tokens, 50);
  assert.equal(p.get('user').tokens, 10);
  assert.equal(p.get('system').tokens, 20);
  assert.ok(p.get('reasoning').tokens > p.get('assistant_text').tokens);
  const summed = priced.rows.reduce((sum, row) => sum + row.tokens, 0);
  assert.ok(Math.abs(summed - 240) < 1e-9);
});

test('tailSeqs walks route-priced tokens from the newest node', () => {
  const tokensBySeq = new Map([[1, 10], [2, 10], [3, 60], [4, 20]]);
  assert.deepEqual([...tailSeqs([1, 2, 3, 4], tokensBySeq, 30)], [4]);
  assert.deepEqual([...tailSeqs([1, 2, 3, 4], tokensBySeq, 100)].sort(), [1, 2, 3, 4]);
  assert.deepEqual([...tailSeqs([1, 2], tokensBySeq, 0)], []);
});

function liveSession() {
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  return {
    id: 'session-stats',
    surface: { nodes: events.map((event) => event.seq) },
    eventAt: (seq) => bySeq.get(Number(seq)),
    requestHeader: () => ({ tools: [{ name: 'read' }, { name: 'bash' }] }),
  };
}

test('stats defaults to the live surface and tokenMeter without reading the raw log', async () => {
  const tool = createSessionLogTool({
    sessionQuery: { readSession: async () => { throw new Error('raw read must not happen for surface stats'); } },
    tokenMeter: { measure: () => ({ totalTokens: 300, surfaceTokens: 240, nodes: [
      { seq: 1, tokens: 20 }, { seq: 2, tokens: 10 }, { seq: 3, tokens: 160 },
      { seq: 4, tokens: 50 }, { seq: 5, tokens: 0 }, { seq: 6, tokens: 0 },
    ] }) },
  });
  const out = await tool.execute({ action: 'stats' }, { agent: { id: 'session-stats', session: liveSession() } });
  assert.match(out, /scope=surface/);
  assert.match(out, /source=tokenMeter/);
  assert.match(out, /reasoning/);
  assert.match(out, /tool_result/);
  assert.match(out, /tools_schema/);
  assert.match(out, /baseline=60/);
});

test('stats raw reports the whole log and labels chars/4 as an estimate', async () => {
  const tool = createSessionLogTool({
    sessionQuery: { readSession: async () => ({ events }) },
  });
  const out = await tool.execute({ action: 'stats', scope: 'raw', session: 'session-stats' }, { agent: { id: 'other' } });
  assert.match(out, /scope=raw/);
  assert.match(out, /chars4 estimate/);
  assert.match(out, /events=6/);
  assert.match(out, /gist/);
});

test('stats tail uses the measured window and the live protect fraction', async () => {
  const prevEngine = continuityState.engine;
  const prevContext = continuityState.context;
  continuityState.engine = { policy: { protect: 0.30 } };
  continuityState.context = { sessionId: 'session-stats', windowTokens: 1000, estTokens: 300, surfaceTokens: 240, baselineTokens: 60 };
  try {
    const tool = createSessionLogTool({
      sessionQuery: { readSession: async () => ({ events }) },
      tokenMeter: { measure: () => ({ totalTokens: 300, surfaceTokens: 240, nodes: [
        { seq: 1, tokens: 20 }, { seq: 2, tokens: 10 }, { seq: 3, tokens: 160 },
        { seq: 4, tokens: 50 }, { seq: 5, tokens: 0 }, { seq: 6, tokens: 0 },
      ] }) },
    });
    const out = await tool.execute({ action: 'stats' }, { agent: { id: 'session-stats', session: liveSession() } });
    assert.match(out, /tail · protect=30%/);
    assert.match(out, /tail · .*300 tokens/);
  } finally {
    continuityState.engine = prevEngine;
    continuityState.context = prevContext;
  }
});
