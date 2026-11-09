import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createIndexUpdater, computeLabelStamp } from '../src/memory/bc-index-updater.mjs';

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'updater-gate-'));
const write = (dir, name, content) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
};
const eventsFor = (turns) => turns.map((turn) => ({
  type: 'assistant/message',
  seq: turn * 10,
  data: { turn, content: [{ type: 'text', text: `第 ${turn} 轮正文` }] },
}));
const sessionQueryFor = (events) => ({ async readSession() { return { events }; } });

const stubLabeler = (delayMs = 0) => ({
  async labelChunked() {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return {
      version: 2,
      candidates: [{ concept: '甲', score: 0.62 }],
      topic: [{ concept: '甲', score: 0.62 }],
      workflow: [],
      scores: { 甲: 0.62 },
      topicScores: { 甲: 0.62 },
      workflowScores: {},
      topicScore: 0.62,
      topicConfidence: 'normal',
      topicMinScore: 0.33,
    };
  },
});

const setup = ({ events, delayMs = 0, withConcepts = true } = {}) => {
  const dir = mkTmp();
  const index = write(dir, 'bc-index.jsonl', '');
  const keywords = write(dir, 'keywords.md', '');
  const concepts = withConcepts ? write(dir, 'concepts.md', '甲 | 甲话题：甲、一、二 | 1 | topic\n') : null;
  const gate = {
    relabelling: new Set(),
    lockOwned: false,
    isBlocked(sessionId) {
      return this.lockOwned === true || (sessionId !== undefined && this.relabelling.has(sessionId));
    },
  };
  const updateIndex = createIndexUpdater({
    file: index,
    stateFile: path.join(dir, 'bc-index-state.json'),
    baselineFile: null,
    sessionQuery: sessionQueryFor(events),
    labeler: stubLabeler(delayMs),
    labels: { 甲: '甲话题：甲、一、二' },
    kinds: { 甲: 'topic' },
    keywordsFile: keywords,
    cmapFile: null,
    conceptsFile: concepts,
    gate,
  });
  return { dir, index, gate, updateIndex, concepts };
};

const readIndex = (index) => fs.readFileSync(index, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

test('labelStamp：给了 concepts.md 就写，没给就不写', async () => {
  const a = setup({ events: eventsFor([1]), withConcepts: true });
  await a.updateIndex({ agent: { session: { id: 's1' } } });
  const rowsA = readIndex(a.index);
  assert.equal(rowsA.length, 1);
  assert.equal(typeof rowsA[0].labelStamp, 'string');
  assert.equal(rowsA[0].labelStamp, computeLabelStamp({ conceptsText: fs.readFileSync(a.concepts, 'utf8') }));

  const b = setup({ events: eventsFor([1]), withConcepts: false });
  await b.updateIndex({ agent: { session: { id: 's1' } } });
  const rowsB = readIndex(b.index);
  assert.equal(rowsB.length, 1);
  assert.equal(rowsB[0].labelStamp, undefined);
});

test('gate 命中：不写盘、不推进 state、行进 pending；解除后一并写入', async () => {
  const { index, gate, updateIndex, dir } = setup({ events: eventsFor([1, 2]) });
  gate.relabelling.add('s1');
  const blocked = await updateIndex({ agent: { session: { id: 's1' } } });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.added, 0);
  assert.equal(readIndex(index).length, 0, '被挡时 index 不应新增行');
  assert.equal(fs.existsSync(path.join(dir, 'bc-index-state.json')), false, '被挡时不应写 state');
  assert.equal(updateIndex.pendingCount('s1'), 2);

  gate.relabelling.delete('s1');
  const resumed = await updateIndex({ agent: { session: { id: 's1' } } });
  assert.equal(resumed.added >= 2, true);
  const rows = readIndex(index);
  assert.deepEqual(rows.map((row) => row.turn), [1, 2]);
  assert.equal(updateIndex.pendingCount('s1'), 0);
});

test('whenIdle：写入进行中时等待，结束后 resolve', async () => {
  const { updateIndex } = setup({ events: eventsFor([1]), delayMs: 80 });
  const run = updateIndex({ agent: { session: { id: 's1' } } });
  assert.equal(updateIndex.isRunning(), true);
  let idleAfterRun = false;
  const idle = updateIndex.whenIdle().then(() => { idleAfterRun = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(idleAfterRun, false, 'running 期间 whenIdle 不应 resolve');
  await run;
  await idle;
  assert.equal(idleAfterRun, true);
  assert.equal(updateIndex.isRunning(), false);
});

test('并发调用：第二次直接 skipped busy，不重复写', async () => {
  const { index, updateIndex } = setup({ events: eventsFor([1]), delayMs: 80 });
  const first = updateIndex({ agent: { session: { id: 's1' } } });
  const second = await updateIndex({ agent: { session: { id: 's1' } } });
  assert.equal(second.skipped, 'busy');
  await first;
  assert.equal(readIndex(index).length, 1);
});
