import assert from 'node:assert/strict';
import test from 'node:test';
import { createBLabeler } from '../src/memory/bc-label.mjs';

// Deterministic fake embedding: two-axis vectors, no model.
function fakeEmbed(texts) {
  return texts.map((text) => {
    const value = String(text);
    if (value.includes('病毒') || value.includes('COVID') || value.includes('疫情')) return [1, 0, 0];
    if (value.includes('游戏') || value.includes('跑团')) return [0, 1, 0];
    if (value.includes('代码') || value.includes('技术')) return [0, 0, 1];
    return [0.2, 0.2, 0.2];
  });
}

function windowedFakeEmbed(texts) {
  return texts.map((text) => fakeEmbed([String(text).slice(0, 512)])[0]);
}

test('B labeler returns ranked generic candidates', async () => {
  const labeler = createBLabeler({ embed: fakeEmbed });
  const result = await labeler.label('COVID-19 病毒 实验室泄漏');
  assert.equal(result.top.concept, '病毒');
  assert.equal(result.unknown, false);
  assert.equal(result.candidates[0].concept, '病毒');
});

test('B labeler marks a blank signal unknown', async () => {
  const labeler = createBLabeler({ embed: fakeEmbed, concepts: ['游戏'] });
  const result = await labeler.label('???', { minScore: 0.9 });
  assert.equal(result.unknown, true);
});

test('v2 labeler splits topic and workflow', async () => {
  const labeler = createBLabeler({
    embed: fakeEmbed,
    concepts: ['跑团叙事', '原文与上下文', '补丁与验证'],
    labels: { 跑团叙事: '跑团 游戏', 原文与上下文: '原文 上下文', 补丁与验证: '代码 补丁' },
    kinds: { 跑团叙事: 'topic', 原文与上下文: 'workflow', 补丁与验证: 'workflow' },
  });
  const result = await labeler.label('跑团 原文 代码');
  assert.equal(result.version, 2);
  assert.equal(result.topic.length, 1);
  assert.equal(result.topic[0].concept, '跑团叙事');
  assert.equal(result.workflow.length <= 2, true);
  assert.equal(result.generic, undefined);
  assert.equal(result.topicConfidence, 'normal');
});

test('v2 labeler leaves topic empty below topicMinScore', async () => {
  const labeler = createBLabeler({
    embed: fakeEmbed,
    concepts: ['跑团叙事', '补丁与验证'],
    labels: { 跑团叙事: '跑团 游戏', 补丁与验证: '代码 补丁' },
    kinds: { 跑团叙事: 'topic', 补丁与验证: 'workflow' },
  });
  const result = await labeler.label('代码', { topicMinScore: 0.33 });
  assert.equal(result.version, 2);
  assert.deepEqual(result.topic, []);
  assert.equal(result.topicScore, null);
  assert.equal(result.topicMinScore, 0.33);
  assert.equal(result.workflow[0].concept, '补丁与验证');
});

test('chunked labeling sees a topic after the embedding window', async () => {
  const labeler = createBLabeler({
    embed: windowedFakeEmbed,
    concepts: ['跑团叙事'],
    labels: { 跑团叙事: '跑团 游戏' },
    kinds: { 跑团叙事: 'topic' },
  });
  const text = `${'普通文字。'.repeat(180)}跑团 掷骰 GM`;
  const whole = await labeler.label(text, { topicMinScore: 0.8 });
  assert.deepEqual(whole.topic, []);
  const chunked = await labeler.labelChunked(text, { topicMinScore: 0.33, chunkChars: 600 });
  assert.equal(chunked.topic[0].concept, '跑团叙事');
  assert.equal(chunked.chunks > 1, true);
});

test('topic baseline centers a hub concept', async () => {
  const labeler = createBLabeler({
    embed: async (texts) => texts.map(() => [1, 0]),
    concepts: ['跑团叙事', '上下文压缩'],
    labels: { 跑团叙事: '跑团', 上下文压缩: '上下文' },
    kinds: { 跑团叙事: 'topic', 上下文压缩: 'topic' },
  });
  const result = await labeler.label('跑团', {
    topicMinScore: 0.33,
    topicCenterMin: 0.02,
    topicLead: 0.02,
    topicBaseline: { 上下文压缩: 0.3 },
  });
  assert.equal(result.topic[0].concept, '跑团叙事');
  assert.equal(result.topicCenteredScores['上下文压缩'], 0.7);
});

test('missing topic baseline falls back to the global mean', async () => {
  const labeler = createBLabeler({
    embed: async (texts) => texts.map(() => [1, 0]),
    concepts: ['跑团叙事', '上下文压缩'],
    labels: { 跑团叙事: '跑团', 上下文压缩: '上下文' },
    kinds: { 跑团叙事: 'topic', 上下文压缩: 'topic' },
  });
  const result = await labeler.label('跑团', {
    topicMinScore: 0.33,
    topicCenterMin: 0.02,
    topicLead: 0.02,
    topicBaseline: { 上下文压缩: 0.3 },
    topicBaselineFallback: 0.3,
  });
  assert.deepEqual(result.topic, []);
});

test('v2 labeler allows empty workflow when lead fails', async () => {
  const labeler = createBLabeler({
    embed: async (texts) => texts.map(() => [1, 0]),
    concepts: ['原文与上下文', '序列扫描'],
    labels: { 原文与上下文: '原文', 序列扫描: '扫描' },
    kinds: { 原文与上下文: 'workflow', 序列扫描: 'workflow' },
  });
  const result = await labeler.label('原文 扫描', {
    minScore: 0.25,
    workflowCenterMin: 0.02,
    workflowLead: 0.02,
    workflowBaseline: { 原文与上下文: 0.3, 序列扫描: 0.3 },
    workflowBaselineFallback: 0.3,
  });
  assert.deepEqual(result.workflow, []);
  assert.equal(result.workflowScores['原文与上下文'], 1);
});
