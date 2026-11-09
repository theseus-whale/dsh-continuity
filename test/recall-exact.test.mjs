import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecallExactTool } from '../src/recall-exact-tool.mjs';

function event(seq, type, data) {
  return { seq, type, time: 1_700_000_000_000 + seq, data };
}

test('recall_exact searches current session and excludes injected blocks', async () => {
  const events = [
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'user/message', { turn: 1, content: [{ type: 'text', text: 'needle here' }] }),
    event(3, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'no match' }] } }),
    event(4, 'turn/start', { turn: 2 }),
    event(5, 'user/message', { turn: 2, content: [{ type: 'text', text: '[规则] injected needle' }] }),
  ];
  const tool = createRecallExactTool({
    sessionQuery: { readSession: async () => ({ events }) },
  });
  const result = JSON.parse(await tool.execute(
    { query: 'needle' },
    { agent: { session: { id: 's' } } },
  ));
  assert.equal(result.ok, true);
  assert.equal(result.totalTurns, 1);
  assert.equal(result.totalIntervals, 1);
  assert.equal(result.surfaceStats.excluded.injected, 1);
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].fromTurn, 1);
});

test('recall_exact rejects a non-whitelisted single CJK char', async () => {
  const tool = createRecallExactTool({
    sessionQuery: { readSession: async () => ({ events: [] }) },
  });
  const result = JSON.parse(await tool.execute(
    { query: '猫' },
    { agent: { session: { id: 's' } } },
  ));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'single-char-cjk-not-whitelisted');
});
