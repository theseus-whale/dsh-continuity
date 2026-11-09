import assert from 'node:assert/strict';
import test from 'node:test';
import {
  backfillRecords, createCMap, deserializeCMap, expandWindow, groupHits, intersectionConcepts, learnFromReference, learnTerm, makeRecord, markAsked, parseReference, recall, referencedRecords, renderNote, retrieve, selectSeeds, serializeCMap, shouldAsk,
} from '../src/memory/bc-recall.mjs';

const records = [
  makeRecord({ turn: 40, seqStart: 100, seqEnd: 110, text: '灯塔钥匙', generic: ['游戏', '故事'], terms: ['跑团'] }),
  makeRecord({ turn: 60, seqStart: 200, seqEnd: 205, text: 'COVID-19 实验室泄漏', generic: ['技术'], terms: ['COVID-19'], status: 'weak' }),
];

test('B direct lookup finds generic records', () => {
  const result = retrieve({ records, cmap: createCMap(), query: '游戏' });
  assert.equal(result.kind, 'recall');
  assert.equal(result.via, 'B');
  assert.equal(result.hits[0].turn, 40);
});

test('recall() is the LLM-facing alias', () => {
  const result = recall({ records, cmap: createCMap(), query: '游戏' });
  assert.equal(result.kind, 'recall');
  assert.equal(result.hits[0].turn, 40);
});

test('cold-start term asks once', () => {
  const cmap = createCMap();
  const first = retrieve({ records, cmap, query: '跑团' });
  assert.equal(first.kind, 'ask');
  assert.equal(first.term, '跑团');
  assert.equal(shouldAsk(cmap, '跑团'), true);
  markAsked(cmap, '跑团');
  assert.equal(shouldAsk(cmap, '跑团'), false);
  assert.equal(retrieve({ records, cmap, query: '跑团' }).kind, 'silent');
});

test('C mapping finds old records after learning', () => {
  const cmap = createCMap();
  learnTerm(cmap, '跑团', ['游戏', '故事', '对话']);
  const result = retrieve({ records, cmap, query: '跑团' });
  assert.equal(result.kind, 'recall');
  assert.equal(result.via, 'C');
  assert.equal(result.hits[0].turn, 40);
  const note = renderNote(result);
  assert.match(note, /\[追忆\] 跑团/);
  assert.doesNotMatch(note, /跑团 -> 游戏/);
  assert.match(note, /可按需前后读更多 turn/);
  assert.doesNotMatch(note, /1–3|1-3|±3/);
});

test('low/unknown concept asks once and known concept without records is silent', () => {
  const unknown = retrieve({ records, cmap: createCMap(), query: '疫情' });
  assert.equal(unknown.kind, 'ask');
  const known = retrieve({ records, cmap: createCMap(), query: '病毒' });
  assert.equal(known.kind, 'silent');
  assert.equal(renderNote({ kind: 'silent' }), null);
});

test('learning a term backfills old records', () => {
  const cmap = createCMap();
  learnTerm(cmap, '跑团', ['游戏', '故事']);
  const old = [makeRecord({ turn: 49, seqStart: 1, seqEnd: 2, text: '旧跑团', generic: [], terms: ['跑团'] })];
  assert.equal(retrieve({ records: old, cmap, query: '跑团' }).kind, 'silent');
  const filled = backfillRecords(old, '跑团', ['游戏', '故事']);
  const result = retrieve({ records: filled, cmap, query: '游戏' });
  assert.equal(result.kind, 'recall');
  assert.equal(result.hits[0].turn, 49);
});

test('C map survives serialization', () => {
  const cmap = createCMap();
  learnTerm(cmap, '跑团', ['游戏']);
  markAsked(cmap, '未知词');
  const restored = deserializeCMap(serializeCMap(cmap));
  assert.deepEqual(restored.terms.get('跑团'), ['游戏']);
  assert.equal(restored.asked.has('未知词'), true);
});

test('COVID weak record is retrievable by its generic concept', () => {
  const covid = makeRecord({ turn: 900, seqStart: 1, seqEnd: 1, text: 'COVID-19 实验室泄漏', generic: ['病毒'], terms: ['COVID-19'], status: 'weak' });
  const result = retrieve({ records: [covid], cmap: createCMap(), query: '病毒' });
  assert.equal(result.kind, 'recall');
  assert.equal(result.hits[0].status, 'weak');
});

test('low concept score is filtered out', () => {
  const noisy = makeRecord({ turn: 1, seqStart: 1, seqEnd: 1, text: 'x', generic: ['病毒'], conceptScores: { 病毒: 0.2 } });
  const result = retrieve({ records: [noisy], cmap: createCMap(), query: '病毒', minConceptScore: 0.4 });
  assert.equal(result.kind, 'silent');
});

test('C entry minB marks low-B hits and K breaks ties without eliminating', () => {
  const cmap = createCMap([{
    term: '跑团',
    generic: ['游戏', '故事', '剧情'],
    keywords: ['Coo'],
    minB: 2,
  }]);
  const records = [
    makeRecord({ turn: 1, seqStart: 1, seqEnd: 1, terms: ['跑团'], generic: ['游戏', '故事'], conceptScores: { 游戏: 0.8, 故事: 0.8 } }),
    makeRecord({ turn: 2, seqStart: 2, seqEnd: 2, terms: ['跑团'], generic: ['游戏'], conceptScores: { 游戏: 0.4 } }),
    makeRecord({ turn: 3, seqStart: 3, seqEnd: 3, terms: ['跑团'], generic: ['游戏', '故事'], conceptScores: { 游戏: 0.8, 故事: 0.8 }, keywords: ['coo'] }),
  ];
  const result = retrieve({ records, cmap, query: '跑团' });
  assert.equal(result.via, 'C');
  assert.equal(result.hits.length, 3);
  assert.equal(result.hits[0].turn, 3);
  assert.equal(result.hits.at(-1).turn, 2);
  assert.equal(result.hits.at(-1).lowB, true);
});

test('C low-B is a rescue path, not a second full list', () => {
  const cmap = createCMap([{ term: '跑团', generic: ['游戏', '故事'], minB: 2 }]);
  const records = [];
  for (let turn = 1; turn <= 4; turn += 1) {
    records.push(makeRecord({ turn, seqStart: turn, seqEnd: turn, terms: ['跑团'], generic: ['游戏', '故事'], conceptScores: { 游戏: 0.8, 故事: 0.8 } }));
  }
  for (let turn = 10; turn < 16; turn += 1) {
    records.push(makeRecord({ turn, seqStart: turn, seqEnd: turn, terms: ['跑团'], generic: ['游戏'], conceptScores: { 游戏: 0.4 } }));
  }
  const result = retrieve({ records, cmap, query: '跑团' });
  assert.equal(result.hits.length, 4);
  assert.equal(result.hits.every((record) => record.lowB === false), true);
});

test('C falls back to record keywords when terms are empty', () => {
  const cmap = createCMap([{ term: '折叠', generic: ['上下文压缩'], minB: 0 }]);
  const records = [
    makeRecord({ turn: 1, seqStart: 1, seqEnd: 1, text: 'x', terms: [], keywords: ['折叠'], conceptScores: { 上下文压缩: 0.8 } }),
    makeRecord({ turn: 2, seqStart: 2, seqEnd: 2, text: 'y', terms: [], keywords: ['折叠'], conceptScores: { 上下文压缩: 0.7 } }),
  ];
  const result = retrieve({ records, cmap, query: '折叠' });
  assert.equal(result.kind, 'recall');
  assert.equal(result.via, 'C');
  assert.equal(result.hits.length, 2);
});

test('K note does not repeat the keyword as a facet', () => {
  const record = makeRecord({ turn: 1, seqStart: 1, seqEnd: 1, text: '', keywords: ['coo'], generic: [] });
  const result = retrieve({ records: [record], query: 'Coo', specialKeywords: ['Coo'] });
  assert.equal(result.via, 'K');
  const note = renderNote(result);
  assert.match(note, /^\[追忆\] Coo ->/);
  assert.equal((note.match(/Coo/g) ?? []).length, 1);
});

test('groupHits keeps separate sessions as separate intervals', () => {
  const hits = [
    makeRecord({ turn: 40, seqStart: 100, seqEnd: 110, text: '' }),
    makeRecord({ turn: 41, seqStart: 111, seqEnd: 120, text: '' }),
    makeRecord({ turn: 600, seqStart: 56503, seqEnd: 56510, text: '' }),
    makeRecord({ turn: 601, seqStart: 56511, seqEnd: 56520, text: '' }),
  ];
  const groups = groupHits(hits);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].fromTurn, 40);
  assert.equal(groups[0].toTurn, 41);
  assert.equal(groups[1].fromTurn, 600);
  const note = renderNote({ kind: 'recall', via: 'C', term: '跑团', concepts: ['游戏'], hits });
  assert.match(note, /> 2 个区间/);
  assert.match(note, /turn 40-41/);
  assert.match(note, /turn 600-601/);
});

test('B direct lookup allows a close second concept but rejects a low top score', () => {
  const highSecond = makeRecord({ turn: 1, seqStart: 1, seqEnd: 1, text: 'x', generic: ['病毒', '游戏'], conceptScores: { 病毒: 0.55, 游戏: 0.58 } });
  assert.equal(retrieve({ records: [highSecond], cmap: createCMap(), query: '病毒' }).kind, 'recall');
  const lowTop = makeRecord({ turn: 2, seqStart: 2, seqEnd: 2, text: 'y', generic: ['病毒'], conceptScores: { 病毒: 0.42 } });
  assert.equal(retrieve({ records: [lowTop], cmap: createCMap(), query: '病毒' }).kind, 'silent');
});

test('reference parsing and intersection learn a term from prior records', () => {
  assert.deepEqual(parseReference('我前两句那个时候说的就是跑团'), { kind: 'count', count: 2 });
  const evidence = [
    makeRecord({ turn: 40, seqStart: 1, seqEnd: 1, text: '灯塔钥匙', generic: ['游戏', '故事', '对话'], terms: ['跑团'] }),
    makeRecord({ turn: 41, seqStart: 2, seqEnd: 2, text: '骰子', generic: ['游戏', '故事', '对话', '规则'], terms: ['跑团'] }),
  ];
  const inter = intersectionConcepts(evidence, { background: ['对话'] });
  assert.deepEqual(inter.allOf, ['游戏', '故事']);
  const cmap = createCMap();
  const learned = learnFromReference(cmap, '跑团', evidence, evidence, { background: ['对话'] });
  assert.equal(learned.ok, true);
  assert.deepEqual(cmap.terms.get('跑团'), ['游戏', '故事']);
  assert.equal(referencedRecords(evidence, 2).length, 2);
});

test('window expansion follows adjacent shared terms and stops at a gap', () => {
  const words = ['钥匙', '灯塔', '船'];
  const seq = [
    makeRecord({ turn: 38, seqStart: 1, seqEnd: 1, text: 'a', generic: ['游戏'], terms: ['跑团'], keywords: words, conceptScores: { 游戏: 0.5 } }),
    makeRecord({ turn: 39, seqStart: 2, seqEnd: 2, text: 'b', generic: ['游戏'], terms: ['跑团'], keywords: words, conceptScores: { 游戏: 0.5 } }),
    makeRecord({ turn: 40, seqStart: 3, seqEnd: 3, text: 'c', generic: ['设备'], terms: ['跑团'], keywords: words, conceptScores: { 游戏: 0.1, 设备: 0.5 } }),
    makeRecord({ turn: 41, seqStart: 4, seqEnd: 4, text: 'd', generic: ['游戏'], terms: ['跑团'], keywords: words, conceptScores: { 游戏: 0.5 } }),
    makeRecord({ turn: 45, seqStart: 5, seqEnd: 5, text: 'e', generic: ['游戏'], terms: ['跑团'], keywords: words, conceptScores: { 游戏: 0.5 } }),
  ];
  const window = expandWindow(seq, seq[2], { maxTurns: 100 });
  assert.deepEqual(window.turns, [38, 39, 40, 41]);
  assert.equal(window.expanded, true);
});

test('intersection seeds require every concept above the score floor', () => {
  const records = [
    makeRecord({ turn: 1, seqStart: 1, seqEnd: 1, generic: ['游戏', '故事', '对话'], conceptScores: { 游戏: 0.5, 故事: 0.5, 对话: 0.5 } }),
    makeRecord({ turn: 2, seqStart: 2, seqEnd: 2, generic: ['游戏', '故事'], conceptScores: { 游戏: 0.5, 故事: 0.5 } }),
    makeRecord({ turn: 3, seqStart: 3, seqEnd: 3, generic: ['游戏', '故事', '对话'], conceptScores: { 游戏: 0.2, 故事: 0.5, 对话: 0.5 } }),
  ];
  const seeds = selectSeeds(records, ['游戏', '故事', '对话'], { minConceptScore: 0.3 });
  assert.deepEqual(seeds.map((record) => record.turn), [1]);
});

