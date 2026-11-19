import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildRawChunks } from '../src/fullseed/chunks.mjs';
import { summarizeChunk, normalizeSummaryText, summaryWarnings } from '../src/fullseed/summary.mjs';
import { createUnifiedFoldBatch } from '../src/fold/unified-fold.mjs';
import { buildTurnsFromEvents } from '../src/turn-ping/host.mjs';
import { DEFAULT_CONFIG } from '../src/turn-ping/config.mjs';
import { validateSummary } from '../src/turn-ping/summary-writer.mjs';

const vec = () => Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0));
const events = [
  { seq: 1, type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Alpha 项目' }] } } },
  { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '完成 12345' }] } } },
];
const chunk = () => buildRawChunks('soft', events, { checkpointSeq: Infinity }).chunks[0];
const cfg = { summary: { maxAttempts: 2, hardMaxChars: 256, promptVersion: 'soft', provider: 'fake', model: 'fake' }, sourceView: { userChars: 4000, assistantChars: 5000, toolChars: 1500, totalChars: 16000, userSourceKinds: ['user'] }, vector: { model: 'BGE', dimensions: 512 } };

test('fullseed soft forms: long, multiline, fence/JSON, plain, weak anchor all pass once', async () => {
  const forms = [
    { text: '长'.repeat(300), warning: /soft-too-long/ },
    { text: '第一行\n第二行', warning: /multiline/ },
    { text: '```json\n{"chunkId":"c","L":"fenced 摘要"}\n```', warning: null, contains: 'fenced 摘要' },
    { text: '{"chunkId":"c","L":"旧 JSON 摘要"}', warning: null, contains: '旧 JSON 摘要' },
    { text: 'plain 摘要', warning: null, contains: 'plain 摘要' },
    { text: '引用 999999 不存在', warning: /unsupported-anchor/ },
  ];
  for (const form of forms) {
    let calls = 0;
    const summary = await summarizeChunk({ chunk: chunk(), callProvider: async () => { calls += 1; return { text: form.text, provider: 'fake', model: 'fake' }; } });
    assert.equal(calls, 1);
    assert.equal(summary.status, 'complete');
    if (form.contains) assert.match(summary.summaryText, new RegExp(form.contains));
    if (form.warning) assert.equal(summary.warnings.some((warning) => form.warning.test(warning)), true);
  }
});

test('unified fold accepts fence/overlong and keeps one provider call', async () => {
  const turns = buildTurnsFromEvents('soft', events);
  const session = { id: 'soft', surface: { nodes: [1, 2] } };
  let calls = 0;
  const batch = createUnifiedFoldBatch({ sessionId: 'soft', session, start: 1, end: 2, events, turns, config: cfg, provider: async () => { calls += 1; return { text: '```json\n{"turnId":"x","L":"' + '长'.repeat(300) + '"}\n```', provider: 'fake', model: 'fake' }; }, embedder: async () => vec(), storage: { async summaries() { return []; }, async vectors() { return []; }, async appendSummary() {}, async appendVector() {}, async writeVectorMeta() {}, async appendLedger() {} }, stagingDir: null });
  const out = await batch.summarize();
  assert.equal(calls, 1);
  assert.equal(out.summary.length, 1);
  assert.equal(batch.batch.records[0].summary.warnings.some((w) => /soft-too-long/.test(w)), true);
});

test('Host generation chains contain no subagent/spawn/workflow dispatch', () => {
  for (const file of ['src/fullseed/host-rebuild.mjs', 'src/fold/unified-fold.mjs', 'src/turn-ping/host-adapters.mjs', 'src/fullseed/llm-adapter.mjs']) {
    const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\b(subagent|spawn|workflow)\b/i);
  }
});

test('normalization and warnings keep long/multiline/fence content', () => {
  const text = normalizeSummaryText('```\nline1\nline2\n```');
  assert.equal(text, 'line1\nline2');
  assert.equal(summaryWarnings('x'.repeat(300), '').some((w) => /soft-too-long/.test(w)), true);
});

test('turn-ping config requests Vector-L while hardMaxChars does not reject', () => {
  assert.equal(DEFAULT_CONFIG.summary.promptVersion, 'turn-ping-summary-v5-vector-l-context');
  assert.equal(DEFAULT_CONFIG.summary.targetChars, 100);
  assert.equal(DEFAULT_CONFIG.summary.hardMaxChars, 256);
  assert.deepEqual(validateSummary('x'.repeat(300), { summary: { hardMaxChars: 256 } }), []);
});
