import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFacetIndex, queryFacets, indexStats } from '../src/facets/index.mjs';
import { emptyCursor, residualCount, scanRows } from '../src/facets/scanner.mjs';
import { predictFacets, trainFacetClassifier, serializeClassifier, deserializeClassifier } from '../src/facets/classifier.mjs';
import { hybridExtractor } from '../src/facets/hybrid.mjs';
import { detectRandom } from '../src/facets/random.mjs';
import { facetScore, sensitivitySeries, foldPriority } from '../src/facets/sensitivity.mjs';
import { buildFacetPanel, buildLoadHint } from '../src/facets/panel.mjs';
import { createFacetService } from '../src/facets/service.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeFacets } from '../src/facets/schema.mjs';

function rows() {
  const out = [];
  for (let turn = 1; turn <= 10; turn += 1) {
    out.push({
      turn,
      seqStart: turn * 10,
      seqEnd: turn * 10 + 1,
      facets: normalizeFacets({
        activity: turn <= 6 ? '跑团' : '调试',
        interaction: turn <= 6 ? '回合制' : '指令式',
        random: turn <= 6 ? '有' : '无',
        participants: turn <= 6 ? '协作' : '协作',
        medium: turn <= 6 ? '文字' : '代码',
        topic: turn <= 6 ? '剧情' : '技术',
      }),
    });
  }
  return out;
}

test('facet index builds idf and query expands alias', () => {
  const index = buildFacetIndex(rows());
  const result = queryFacets(index, '跑团');
  assert.equal(result.facets.activity, '跑团');
  assert.ok(result.matches.length >= 6);
  assert.equal(result.matches[0].turn, 1);
  assert.ok(result.ranges.length >= 1);
  const stats = indexStats(index);
  assert.equal(stats.total, 10);
  assert.equal(stats.unknown, 0);
});

test('query requires coverage and ranks tool turns separately', () => {
  const index = buildFacetIndex(rows());
  const debug = queryFacets(index, '调试');
  assert.ok(debug.matches.length > 0);
  assert.ok(debug.matches.every((hit) => hit.turn >= 7));
});

test('unknown turn is counted but not queried', () => {
  const index = buildFacetIndex([
    { turn: 1, seqStart: 1, seqEnd: 1, facets: {} },
    { turn: 2, seqStart: 2, seqEnd: 2, text: 'zzzz qqqq' },
  ]);
  const stats = indexStats(index);
  assert.equal(stats.total, 2);
  assert.equal(stats.unknown, 2);
  assert.equal(queryFacets(index, '跑团').matches.length, 0);
});

test('scanner advances past unknowns and is incremental', () => {
  const rows = [
    { turn: 1, seqStart: 1, seqEnd: 1, text: '掷骰 跑团 剧情 协作 文字' },
    { turn: 2, seqStart: 2, seqEnd: 2, text: 'zzzz qqqq' },
    { turn: 3, seqStart: 3, seqEnd: 3, text: '调试 代码 日志' },
  ];
  const first = scanRows(rows, emptyCursor());
  assert.equal(first.entries.length, 3);
  assert.equal(residualCount(first.cursor), 1);
  assert.equal(first.cursor.lastSeq, 3);
  const second = scanRows(rows, first.cursor);
  assert.equal(second.entries.length, 0);
  assert.equal(residualCount(second.cursor), 1);
});

test('local Naive Bayes classifier has a working train/predict path', () => {
  const model = trainFacetClassifier([
    { text: '掷骰 跑团 剧情 画面 协作', facets: { activity: '跑团', topic: '剧情', medium: '文字', participants: '协作' } },
    { text: '跑团 角色 剧情 对话', facets: { activity: '跑团', topic: '剧情', medium: '文字', participants: '协作' } },
    { text: '调试 代码 日志 报错', facets: { activity: '调试', topic: '技术', medium: '代码', participants: '协作' } },
    { text: '测试 用例 回归 检查', facets: { activity: '测试', topic: '技术', medium: '代码', participants: '协作' } },
  ]);
  const result = predictFacets(model, '掷骰 跑团 剧情 角色');
  assert.equal(result.unknown, false);
  assert.equal(result.facets.activity, '跑团');
  const restored = deserializeClassifier(serializeClassifier(model));
  assert.deepEqual(predictFacets(restored, '掷骰 跑团 剧情 角色').facets, result.facets);
  const hybrid = hybridExtractor(model)('掷骰 跑团 剧情 角色');
  assert.equal(hybrid.facets.random, '有');
  assert.equal(hybrid.facets.activity, '跑团');
  assert.equal(detectRandom('掷骰 D20').value, '有');
  assert.equal(detectRandom('d100 = 59; Get-Random -Minimum 1 -Maximum 101').value, '有');
  assert.equal(detectRandom('调试 日志 代码').value, '无');
});

test('sensitivity scoring separates topic from unrelated turns', () => {
  const rows = [];
  const run = { activity: '跑团', interaction: '回合制', random: '有', participants: '协作', medium: '文字', topic: '剧情' };
  const tech = { activity: '调试', interaction: '指令式', random: '无', participants: '协作', medium: '代码', topic: '技术' };
  for (let turn = 1; turn <= 10; turn += 1) {
    rows.push({ turn, seqStart: turn, seqEnd: turn, facets: turn <= 5 ? run : tech });
  }
  const index = buildFacetIndex(rows);
  const query = { activity: '跑团', interaction: '回合制', participants: '协作', medium: '文字', topic: '剧情' };
  const series = sensitivitySeries(index.entries, query, { idf: index.idf });
  const runAvg = series.slice(0, 5).reduce((sum, row) => sum + row.smoothed, 0) / 5;
  const techAvg = series.slice(5).reduce((sum, row) => sum + row.smoothed, 0) / 5;
  assert.ok(runAvg > techAvg * 2);
  assert.ok(facetScore(run, query, index.idf).score > facetScore(tech, query, index.idf).score);
});

test('fold priority protects current topic and prefers old low relevance', () => {
  const rows = [];
  for (let turn = 1; turn <= 30; turn += 1) {
    rows.push({
      turn,
      seqStart: turn,
      seqEnd: turn,
      facets: turn <= 20
        ? { activity: '调试', topic: '技术' }
        : { activity: '跑团', topic: '剧情' },
    });
  }
  const index = buildFacetIndex(rows);
  const priority = foldPriority(index.entries, { activity: '跑团', topic: '剧情' }, { idf: index.idf, recentTurns: 5 });
  assert.ok(priority.length > 0);
  assert.ok(priority.every((row) => row.turn <= 25));
});

test('facet worker extracts off-thread from a serialized model', async () => {
  const model = trainFacetClassifier([
    { text: 'dice rpg story scene co-op', facets: { activity: '跑团', topic: '剧情', medium: '文字', participants: '协作' } },
    { text: 'rpg character story dialogue', facets: { activity: '跑团', topic: '剧情', medium: '文字', participants: '协作' } },
    { text: 'debug code log error', facets: { activity: '调试', topic: '技术', medium: '代码', participants: '协作' } },
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facet-worker-'));
  const file = path.join(dir, 'model.json');
  fs.writeFileSync(file, JSON.stringify(serializeClassifier(model)));
  const service = createFacetService({ modelPath: file });
  try {
    const result = await service.extract('dice rpg story scene co-op');
    assert.ok(result.facets.activity !== undefined);
    assert.equal(result.facets.random, '无');
  } finally {
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('facet panel counts multi-label turns and current alias pairs', () => {
  const rows = [];
  for (let turn = 1; turn <= 20; turn += 1) {
    rows.push({
      turn,
      seqStart: turn,
      seqEnd: turn,
      facets: turn <= 10
        ? { activity: '跑团', interaction: '回合制', random: '有', participants: '协作', medium: '文字', topic: '剧情' }
        : { activity: '调试', interaction: '指令式', random: '无', participants: '协作', medium: '代码', topic: '技术' },
    });
  }
  const index = buildFacetIndex(rows);
  const panel = buildFacetPanel(index.entries, { idf: index.idf, currentAlias: '跑团' });
  assert.equal(panel.totalTurns, 20);
  assert.equal(panel.unknown, 0);
  assert.ok(panel.facetSum > panel.totalTurns);
  assert.equal(panel.currentTopic.alias, '跑团');
  assert.ok(panel.currentTopic.pairs.length >= 1);
  assert.equal(panel.currentTopic.pairs[0].value, '跑团');
  assert.equal(panel.curve.length, 20);
  assert.ok(panel.curve.slice(0, 10).every((row) => row.score > 0));
  assert.ok(panel.curve.slice(10).every((row) => row.score < 0.3));
});

test('load hint appears only when the topic is not recent', () => {
  const rows = [];
  for (let turn = 1; turn <= 5; turn += 1) {
    rows.push({ turn, seqStart: turn, seqEnd: turn, facets: { activity: '跑团', topic: '剧情', interaction: '回合制', medium: '文字', participants: '协作' } });
  }
  const index = buildFacetIndex(rows);
  const hint = buildLoadHint(index.entries, { idf: index.idf, query: '跑团', recentTurns: 20, minScore: 0.1, currentTurn: 30 });
  assert.ok(hint !== null);
  assert.match(hint.text, /话题线索/);

  const recentRows = [
    ...rows,
    { turn: 30, seqStart: 30, seqEnd: 30, facets: { activity: '跑团', topic: '剧情', interaction: '回合制', medium: '文字', participants: '协作' } },
  ];
  const recentIndex = buildFacetIndex(recentRows);
  assert.equal(buildLoadHint(recentIndex.entries, { idf: recentIndex.idf, query: '跑团', recentTurns: 20 }), null);
});

test('facet panel state reports missing and available snapshots', async () => {
  const { buildFacetState } = await import('../src/facets/panel-state.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'facet-panel-'));
  try {
    assert.equal(buildFacetState({ home }).available, false);
    const dir = path.join(home, '.dsh', 'continuity');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'facet-panel.json'), JSON.stringify({ totalTurns: 3 }));
    const state = buildFacetState({ home });
    assert.equal(state.available, true);
    assert.equal(state.panel.totalTurns, 3);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('facet load query turns an alias into loadable seqs', async () => {
  const { saveIndex } = await import('../src/facets/store.mjs');
  const { loadFacetQuery } = await import('../src/facets/load.mjs');
  const rows = [
    { turn: 1, seqStart: 10, seqEnd: 11, facets: { activity: '跑团', topic: '剧情', interaction: '回合制', medium: '文字', participants: '协作' } },
    { turn: 2, seqStart: 20, seqEnd: 21, facets: { activity: '调试', topic: '技术', interaction: '指令式', medium: '代码', participants: '单人' } },
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facet-load-'));
  const file = path.join(dir, 'index.json');
  try {
    saveIndex(file, buildFacetIndex(rows));
    const result = loadFacetQuery('跑团', { indexFile: file, topK: 10 });
    assert.deepEqual(result.seqs, [10, 11]);
    assert.equal(result.ranges.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('facet fold plan prefers old low-relevance ranges and protects current topic', async () => {
  const { planFacetFold } = await import('../src/facets/fold-plan.mjs');
  const rows = [];
  for (let turn = 1; turn <= 30; turn += 1) {
    rows.push({
      turn,
      seqStart: turn,
      seqEnd: turn,
      facets: turn <= 20
        ? { activity: '调试', topic: '技术', medium: '代码' }
        : { activity: '跑团', topic: '剧情', medium: '文字' },
    });
  }
  const index = buildFacetIndex(rows);
  const plan = planFacetFold(index.entries, {
    query: { activity: '跑团', topic: '剧情' },
    idf: index.idf,
    recentTurns: 5,
    budgetTokens: 10,
    tokensBySeq: new Map(rows.map((row) => [row.seqStart, 1])),
  });
  assert.ok(plan.ranges.length > 0);
  assert.ok(plan.seqs.every((seq) => seq <= 20));
  assert.ok(plan.protected.some((row) => row.turn > 20));
});

test('facet fold file loads entries/query/idf for the engine', async () => {
  const { loadFacetFoldFile } = await import('../src/facets/fold-plan.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facet-foldfile-'));
  const file = path.join(dir, 'facet-fold.json');
  try {
    fs.writeFileSync(file, JSON.stringify({
      query: { activity: '跑团' },
      idf: [['activity:跑团', 2]],
      entries: [{ turn: 1, seqStart: 1, seqEnd: 2, facets: { activity: '跑团' } }],
    }));
    const config = loadFacetFoldFile(file);
    assert.equal(config.entries.length, 1);
    assert.equal(config.query.activity, '跑团');
    assert.equal(config.idf.get('activity:跑团'), 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hybrid abstains when every learned slot is below threshold', async () => {
  const model = trainFacetClassifier([
    { text: 'alpha beta gamma', facets: { activity: '开发', topic: '技术' } },
    { text: 'delta epsilon zeta', facets: { activity: '调试', topic: '技术' } },
  ]);
  const abstain = hybridExtractor(model, { minConfidence: 1.1 })('alpha beta gamma');
  assert.equal(abstain.unknown, true);
  assert.equal(abstain.facets.activity, undefined);
});

test('MLP probe runs a two-layer forward pass', async () => {
  const { deserializeMlp, predictMlp } = await import('../src/facets/mlp-probe.mjs');
  const model = deserializeMlp({ slots: { activity: {
    classes: ['a', 'b'],
    w1: [[1], [1]],
    b1: [0],
    w2: [[1, -1]],
    b2: [-2, 0],
  } } });
  assert.equal(predictMlp(model, [1, 1]).facets.activity, 'a');
  assert.equal(predictMlp(model, [-1, -1]).facets.activity, 'b');
});
