import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChunkPing, CLUE_NOTE as fullseedNote } from '../src/fullseed/ping.mjs';
import { CLUE_NOTE as legacyNote } from '../src/turn-ping/ping.mjs';
import { memoryCueMessage } from '../src/memory-cue.mjs';
import { createMemoryRecallTool } from '../src/turn-ping/memory-recall-tool.mjs';

const expected = '摘要仅作定位：按 seq 回读；追溯用原文措辞＋beforeSeq 查更早。无命中≠不存在。';

test('automatic cue and manual memory_recall share the same concise guidance', async () => {
  assert.equal(fullseedNote, expected);
  assert.equal(legacyNote, expected);

  const summary = {
    chunkId: 'chunk-a',
    turnId: 'turn-1',
    seqStart: 1,
    seqEnd: 2,
    availableCutoff: 2,
    summaryText: '摘要正文',
  };
  const config = { retrieval: { maxSummariesPerFacet: 4, maxPingUtf8Bytes: 16384 } };
  const ping = buildChunkPing({
    summaries: [summary],
    scored: [{ chunkId: 'chunk-a', score: 1 }],
    cutoff: 2,
    config,
  });
  assert.ok(ping.text.includes(expected));

  const cue = memoryCueMessage(ping.text);
  assert.equal(cue.source.kind, 'memory-cue');
  assert.ok(cue.content[0].text.includes(expected));

  const tool = createMemoryRecallTool({
    beforeAnswer: async () => ({ enabled: true, ping, H: 1, retrieval: {} }),
    resolveSessionQuery: () => ({
      readSession: async () => ({ events: [{ seq: 2 }], surface: { nodes: [2] } }),
    }),
  });
  const output = await tool.execute(
    { query: '核实旧决定' },
    { agent: { session: { id: 'session-a' } } },
  );
  assert.ok(output.includes(expected));
});
