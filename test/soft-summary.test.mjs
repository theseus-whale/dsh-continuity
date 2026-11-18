import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRawChunks } from '../src/fullseed/chunks.mjs';
import { summarizeChunk, normalizeSummaryText, summaryWarnings } from '../src/fullseed/summary.mjs';
import { buildRepairPlan, runRepair } from '../src/fullseed/repair.mjs';
import { stagingPaths } from '../src/fullseed/seed.mjs';
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

test('repair accepts overlong multiline text and does not retry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soft-repair-'));
  const raw = buildRawChunks('soft', events, { checkpointSeq: Infinity }).chunks;
  const oldId = 'old';
  const p = stagingPaths(root, oldId);
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.summaries, JSON.stringify({ sessionId: 'soft', turnId: 't0', chunkId: raw[0].chunkId, seqStart: 1, seqEnd: 2, rawTextSha256: raw[0].rawTextSha256, summaryText: 'old', summarySha256: 'old', availableCutoff: 2 }) + '\n');
  fs.writeFileSync(p.vectors, JSON.stringify({ chunkId: raw[0].chunkId, summarySha256: 'old', dimensions: 512, values: vec() }) + '\n');
  const plan = { rows: [{ chunkId: raw[0].chunkId }], chunks: [raw[0]], allChunks: new Map([[raw[0].chunkId, raw[0]]]), eventsBySeq: new Map(events.map((e) => [e.seq, e])), missing: [raw[0]], oldAccepted: [], oldVectors: [], cohorts: [oldId], currentCalls: 4287, maxProviderCalls: 7802, remaining: 3515, repairIdentity: 'r', oldIdentity: oldId };
  let calls = 0;
  const result = await runRepair({ plan, provider: async () => { calls += 1; return { text: '长'.repeat(300) + '\n第二行', provider: 'fake', model: 'fake' }; }, embedder: async () => vec(), root, repairIdentity: 'r', dryRun: false, initialCalls: 4287, maxProviderCalls: 7802, repairMaxCalls: 56, approve: true, expectedMissing: 1 });
  assert.equal(calls, 1);
  assert.equal(result.pending, 0);
  const stored = JSON.parse(fs.readFileSync(stagingPaths(root, 'r').summaries, 'utf8').trim());
  assert.match(stored.summaryText, /长/);
  assert.equal(stored.warnings.some((w) => /soft-too-long/.test(w)), true);
});

test('unified fold accepts fence/overlong and keeps one provider call', async () => {
  const turns = buildTurnsFromEvents('soft', events);
  const session = { id: 'soft', surface: { nodes: [1, 2] } };
  let calls = 0;
  const batch = createUnifiedFoldBatch({ sessionId: 'soft', session, start: 1, end: 2, events, turns, config: cfg, provider: async ({ turn }) => { calls += 1; return { text: '```json\n{"turnId":"x","L":"' + '长'.repeat(300) + '"}\n```', provider: 'fake', model: 'fake' }; }, embedder: async () => vec(), storage: { async summaries() { return []; }, async vectors() { return []; }, async appendSummary() {}, async appendVector() {}, async writeVectorMeta() {}, async appendLedger() {} }, stagingDir: null });
  const out = await batch.summarize();
  assert.equal(calls, 1);
  assert.equal(out.summary.length, 1);
  assert.equal(batch.batch.records[0].summary.warnings.some((w) => /soft-too-long/.test(w)), true);
});

test('chains contain no subagent/spawn/workflow dispatch', () => {
  for (const file of ['src/fullseed/repair.mjs', 'src/fold/unified-fold.mjs', 'src/turn-ping/host-adapters.mjs', 'src/fullseed/llm-adapter.mjs']) {
    const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\b(subagent|spawn|workflow)\b/i);
  }
});

test('normalization and warnings keep long/multiline/fence content', () => {
  const text = normalizeSummaryText('```\nline1\nline2\n```');
  assert.equal(text, 'line1\nline2');
  assert.equal(summaryWarnings('x'.repeat(300), '').some((w) => /soft-too-long/.test(w)), true);
});

test('multi-cohort plan merges old staging directories without duplicates', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soft-cohorts-'));
  const localEvents = [...events, { seq: 3, type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Beta' }] } } }, { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'b' }] } } }, { seq: 5, type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Gamma' }] } } }, { seq: 6, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'g' }] } } }];
  const raw = buildRawChunks('soft', localEvents, { checkpointSeq: Infinity }).chunks;
  const mk = (dirName, chunk) => {
    const dir = path.join(root, 'staging', dirName); fs.mkdirSync(dir, { recursive: true });
    const summary = { sessionId: 'soft', turnId: chunk.turnId, chunkId: chunk.chunkId, seqStart: chunk.seqStart, seqEnd: chunk.seqEnd, rawTextSha256: chunk.rawTextSha256, summaryText: 'old-' + chunk.chunkId, summarySha256: 'sha-' + chunk.chunkId, availableCutoff: 2 };
    fs.writeFileSync(path.join(dir, 'summaries.jsonl'), JSON.stringify(summary) + '\n');
    fs.writeFileSync(path.join(dir, 'vectors.jsonl'), JSON.stringify({ chunkId: chunk.chunkId, summarySha256: summary.summarySha256, dimensions: 512, values: vec() }) + '\n');
  };
  mk('cohort-a', raw[0]); mk('cohort-b', raw[1]);
  const missing = path.join(root, 'missing.json'); fs.writeFileSync(missing, JSON.stringify({ rows: [{ chunkId: raw[2].chunkId }] }));
  const plan = buildRepairPlan({ events: localEvents, sessionId: 'soft', checkpointSeq: Infinity, missingPath: missing, oldIdentity: 'cohort-a', oldCohorts: ['cohort-a', 'cohort-b'], repairIdentity: 'new', root, maxProviderCalls: 7802, initialCalls: 4287 });
  assert.equal(plan.oldAccepted.length, 2);
  assert.equal(new Set(plan.oldAccepted.map((s) => s.chunkId)).size, 2);
  assert.equal(plan.missing.length, 1);
  assert.deepEqual(plan.cohorts, ['cohort-a', 'cohort-b']);
});

test('turn-ping config is soft v2 and hardMaxChars does not reject', () => {
  assert.equal(DEFAULT_CONFIG.summary.promptVersion, 'turn-ping-summary-v2-soft');
  assert.equal(DEFAULT_CONFIG.summary.targetChars, 256);
  assert.equal(DEFAULT_CONFIG.summary.hardMaxChars, 256);
  assert.deepEqual(validateSummary('x'.repeat(300), { summary: { hardMaxChars: 256 } }), []);
});

test('repair call budget is hard across a batch and pending includes unprocessed chunks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soft-budget-'));
  const localEvents = [...events, { seq: 3, type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Beta' }] } } }, { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'b' }] } } }, { seq: 5, type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Gamma' }] } } }, { seq: 6, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'g' }] } } }];
  const raw = buildRawChunks('soft', localEvents, { checkpointSeq: Infinity }).chunks;
  const missing = path.join(root, 'missing.json'); fs.writeFileSync(missing, JSON.stringify({ rows: [{ chunkId: raw[2].chunkId }, { chunkId: raw[1].chunkId }] }));
  const plan = buildRepairPlan({ events: localEvents, sessionId: 'soft', checkpointSeq: Infinity, missingPath: missing, oldIdentity: 'none', repairIdentity: 'new', root, maxProviderCalls: 7802, initialCalls: 100 });
  let calls = 0;
  const result = await runRepair({ plan, provider: async () => { calls += 1; return { text: '', provider: 'fake', model: 'fake' }; }, embedder: async () => vec(), root, repairIdentity: 'new', dryRun: false, initialCalls: 100, maxProviderCalls: 7802, repairMaxCalls: 1, approve: true, expectedMissing: 2 });
  assert.equal(calls, 1);
  assert.equal(result.usedCalls, 1);
  assert.equal(result.pending, 2);
  assert.equal(result.activated, false);
  assert.ok(result.unprocessed.length >= 1);
  assert.equal(fs.existsSync(path.join(root, 'active.json')), false);
});
