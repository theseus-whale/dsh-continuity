import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRecallIndex, findRecall, renderRecall } from '../src/memory/recall.mjs';

const events = [
  { type: 'user/message', seq: 120, data: { turn: 49, content: [{ type: 'text', text: '我们上次去跑团，在灯塔找到钥匙。' }] } },
  { type: 'assistant/message', seq: 121, data: { turn: 49, content: [{ type: 'text', text: '拿到钥匙。' }] } },
  { type: 'user/message', seq: 200, data: { turn: 50, content: [{ type: 'text', text: '今天天气不错。' }] } },
  { type: 'user/message', seq: 300, data: { turn: 51, content: [{ type: 'text', text: '我们接下来去跑团吧。' }] } },
];

test('recall finds a previous turn and seq', () => {
  const recall = buildRecallIndex(events, { beforeTurn: 51 });
  const hits = findRecall(recall, '我们接下来去跑团吧', { minCoverage: 0.2 });
  assert.equal(hits.length > 0, true);
  assert.equal(hits[0].turn, 49);
  assert.equal(hits[0].seqStart, 120);
  assert.match(renderRecall(hits[0]), /turn 49 \/ seq 120/);
});

test('recall ignores injected context messages', () => {
  const recall = buildRecallIndex([
    ...events,
    { type: 'user/message', seq: 301, data: { turn: 51, content: [{ type: 'text', text: '[抽取] zh\ncharacters: -' }] } },
  ], { beforeTurn: 52 });
  assert.equal(recall.records.some((record) => record.text.startsWith('[抽取]')), false);
});
