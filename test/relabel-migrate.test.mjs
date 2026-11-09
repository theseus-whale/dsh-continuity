import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LABELER_VERSION } from '../src/memory/bc-label.mjs';
import { conceptsHash, decideTopic, runRelabelMigration } from '../src/memory/relabel-migrate.mjs';

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'relabel-test-'));
const writeConcepts = (dir, text = '甲 | 甲话题：甲、一、二 | 1 | topic\n乙 | 乙话题：乙、三、四 | 1 | topic\n') => {
  const file = path.join(dir, 'concepts.md');
  fs.writeFileSync(file, text, 'utf8');
  return file;
};
const writeIndex = (dir, rows) => {
  const file = path.join(dir, 'bc-index.jsonl');
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  return file;
};
const writeMarker = (dir, extra = {}) => {
  const file = path.join(dir, 'bc-index.relabel-pending.json');
  fs.writeFileSync(file, JSON.stringify({ fields: ['topic'], baseline: 'self-loo', ...extra }), 'utf8');
  return file;
};
const eventsFor = (turns) => async () => turns.map((turn) => ({
  type: 'assistant/message',
  seq: turn * 10,
  data: { turn, content: [{ type: 'text', text: `第 ${turn} 轮正文` }] },
}));
const eventText = (event) => (event?.data?.content ?? [])
  .filter((block) => block?.type === 'text')
  .map((block) => block.text)
  .join('\n');

// 固定分数的假 labeler：turn 为奇数 → 甲 0.62 / 乙 0.40；偶数 → 乙 0.61 / 甲 0.41
const fakeLabeler = () => ({
  async labelChunked(text) {
    const turn = Number(String(text).match(/第 (\d+) 轮/)?.[1] ?? 0);
    const odd = turn % 2 === 1;
    const topic = odd
      ? [{ concept: '甲', score: 0.62 }, { concept: '乙', score: 0.40 }]
      : [{ concept: '乙', score: 0.61 }, { concept: '甲', score: 0.41 }];
    return { topic, workflow: [], topicScores: Object.fromEntries(topic.map((t) => [t.concept, t.score])) };
  },
});

const baseRows = (turns) => turns.map((turn) => ({ turn, seqStart: turn * 10, seqEnd: turn * 10, genericTopic: [], keywords: [`k${turn}`] }));

test('无事件源 → abort no-event-source，文件不动', async () => {
  const dir = mkTmp();
  const index = writeIndex(dir, baseRows([1, 2]));
  const before = fs.readFileSync(index, 'utf8');
  const marker = writeMarker(dir, { conceptsHash: conceptsHash(writeConcepts(dir)) });
  const result = await runRelabelMigration({
    indexFile: index, conceptsFile: path.join(dir, 'concepts.md'), markerFile: marker,
    labeler: fakeLabeler(), eventText,
  });
  assert.equal(result.status, 'abort');
  assert.equal(result.reason, 'no-event-source');
  assert.equal(fs.readFileSync(index, 'utf8'), before);
});

test('events provider 正常路径：写 topic、补 labelStamp、删 marker、留备份', async () => {
  const dir = mkTmp();
  const index = writeIndex(dir, baseRows([1, 2]));
  const concepts = writeConcepts(dir);
  const marker = writeMarker(dir, { conceptsHash: conceptsHash(concepts) });
  const result = await runRelabelMigration({
    indexFile: index, events: eventsFor([1, 2]), conceptsFile: concepts, markerFile: marker,
    labeler: fakeLabeler(), eventText, log: () => {},
  });
  assert.equal(result.status, 'done');
  assert.equal(result.stats.relabelled, 2);
  assert.equal(fs.existsSync(marker), false);
  const rows = fs.readFileSync(index, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(rows[0].genericTopic, ['甲']);
  assert.deepEqual(rows[1].genericTopic, ['乙']);
  for (const row of rows) {
    assert.equal(typeof row.labelStamp, 'string');
    assert.equal(row.labelStamp.length, 12);
    assert.equal(row.topicMinScore, 0.33);
    assert.equal(row.keywords.length, 1); // 非目标字段保持
  }
  assert.equal(rows[0].labelStamp, rows[1].labelStamp);
  const backups = fs.readdirSync(dir).filter((name) => name.includes('.bak-'));
  assert.equal(backups.length, 1);
});

test('事件覆盖不足 → 打标之前的覆盖检查就 abort，不烧 CPU、不写文件', async () => {
  const dir = mkTmp();
  const index = writeIndex(dir, baseRows([1, 2, 3]));
  const before = fs.readFileSync(index, 'utf8');
  const concepts = writeConcepts(dir);
  const marker = writeMarker(dir, { conceptsHash: conceptsHash(concepts) });
  let labelCalls = 0;
  const countingLabeler = {
    async labelChunked(text) {
      labelCalls += 1;
      return fakeLabeler().labelChunked(text);
    },
  };
  const result = await runRelabelMigration({
    indexFile: index, events: eventsFor([1, 2]), conceptsFile: concepts, markerFile: marker,
    labeler: countingLabeler, eventText, log: () => {},
  });
  assert.equal(result.status, 'abort');
  assert.equal(result.reason, 'read-not-covering');
  assert.equal(result.missing, 1);
  assert.deepEqual(result.missingSample, [3]);
  assert.equal(result.indexTurns, 3);
  assert.equal(result.turnsFromEvents, 2);
  assert.equal(labelCalls, 0, '覆盖不足必须在任何打标之前失败（否则等于白烧 CPU）');
  assert.equal(fs.readFileSync(index, 'utf8'), before);
  assert.equal(fs.readdirSync(dir).filter((name) => name.includes('.bak-')).length, 0);
  assert.equal(fs.existsSync(marker), true, 'marker 必须保留以便重试');
});

test('marker.labelerVersion 覆盖会改变 stamp；默认取 LABELER_VERSION', async () => {
  const stamps = [];
  for (const override of [null, '999']) {
    const dir = mkTmp();
    const index = writeIndex(dir, baseRows([1]));
    const concepts = writeConcepts(dir);
    const marker = writeMarker(dir, { conceptsHash: conceptsHash(concepts), ...(override ? { labelerVersion: override } : {}) });
    const result = await runRelabelMigration({
      indexFile: index, events: eventsFor([1]), conceptsFile: concepts, markerFile: marker,
      labeler: fakeLabeler(), eventText, log: () => {},
    });
    assert.equal(result.status, 'done');
    stamps.push(JSON.parse(fs.readFileSync(index, 'utf8').trim()).labelStamp);
  }
  assert.notEqual(stamps[0], stamps[1], '覆盖版本号必须改变 stamp');
  assert.ok(Number.isFinite(Number(LABELER_VERSION)), 'LABELER_VERSION 必须是数字');
});

test('阈值非法 → 回退默认并写进 topicMinScore', async () => {
  const dir = mkTmp();
  const index = writeIndex(dir, baseRows([1]));
  const concepts = writeConcepts(dir);
  const marker = writeMarker(dir, { conceptsHash: conceptsHash(concepts), thresholds: { topicMinScore: 'nope' } });
  const warnings = [];
  const result = await runRelabelMigration({
    indexFile: index, events: eventsFor([1]), conceptsFile: concepts, markerFile: marker,
    labeler: fakeLabeler(), eventText, log: (message) => warnings.push(message),
  });
  assert.equal(result.status, 'done');
  const row = JSON.parse(fs.readFileSync(index, 'utf8').trim());
  assert.equal(row.topicMinScore, 0.33);
  assert.ok(warnings.some((message) => message.includes('thresholds.topicMinScore')));
});

test('conceptsHash 不符 → abort，文件不动', async () => {
  const dir = mkTmp();
  const index = writeIndex(dir, baseRows([1]));
  const before = fs.readFileSync(index, 'utf8');
  const concepts = writeConcepts(dir);
  const marker = writeMarker(dir, { conceptsHash: 'not-the-current-hash' });
  const result = await runRelabelMigration({
    indexFile: index, events: eventsFor([1]), conceptsFile: concepts, markerFile: marker,
    labeler: fakeLabeler(), eventText, log: () => {},
  });
  assert.equal(result.status, 'abort');
  assert.equal(result.reason, 'concepts-hash-mismatch');
  assert.equal(fs.readFileSync(index, 'utf8'), before);
});

test('decideTopic：领先不足判空、绝对下限守门', () => {
  const baseline = { 甲: 0.4, 乙: 0.4 };
  assert.equal(decideTopic({ 甲: 0.5, 乙: 0.49 }, baseline), null, '领先 .01 < .02 → 空');
  assert.deepEqual(
    decideTopic({ 甲: 0.6, 乙: 0.4 }, baseline).concept,
    '甲',
  );
  assert.equal(decideTopic({ 甲: 0.31, 乙: 0.2 }, baseline), null, '绝对分 .31 < .33 → 空');
});

test('全表 labelStamp 已是当前值 -> noop，不调用 labeler', async () => {
  const dir = mkTmp();
  const index = writeIndex(dir, baseRows([1, 2]));
  const concepts = writeConcepts(dir);
  const firstMarker = writeMarker(dir, { conceptsHash: conceptsHash(concepts) });
  const first = await runRelabelMigration({
    indexFile: index, events: eventsFor([1, 2]), conceptsFile: concepts, markerFile: firstMarker,
    labeler: fakeLabeler(), eventText, log: () => {},
  });
  assert.equal(first.status, 'done');
  const marker = writeMarker(dir, { conceptsHash: conceptsHash(concepts) });
  let labelCalls = 0;
  const counting = {
    async labelChunked(text) {
      labelCalls += 1;
      return fakeLabeler().labelChunked(text);
    },
  };
  const second = await runRelabelMigration({
    indexFile: index, events: eventsFor([1, 2]), conceptsFile: concepts, markerFile: marker,
    labeler: counting, eventText, log: () => {},
  });
  assert.equal(second.status, 'done');
  assert.equal(second.noop, true);
  assert.equal(second.stats.relabelled, 0);
  assert.equal(labelCalls, 0);
  assert.equal(fs.existsSync(marker), false);
});
