import test from 'node:test';
import assert from 'node:assert/strict';
import { createUnifiedFoldBatch, unifiedContentHash, recoverUnifiedPending } from '../src/fold/unified-fold.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTurnsFromEvents } from '../src/turn-ping/host.mjs';
import { sha256 } from '../src/turn-ping/config.mjs';

const vec = () => Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0));
function event(seq, type, text, source = null) {
  return { seq, type, data: { message: { content: [{ type: 'text', text }], ...(source ? { source } : {}) } } };
}
function fixture() {
  const events = [
    event(1, 'user/message', 'u1', { kind: 'user' }), event(2, 'assistant/message', 'a1'),
    event(3, 'user/message', 'u2', { kind: 'user' }), event(4, 'assistant/message', 'a2'),
    event(5, 'user/message', 'u3', { kind: 'user' }), event(6, 'assistant/message', 'a3'),
  ];
  const turns = buildTurnsFromEvents('s1', events);
  const session = { id: 's1', surface: { nodes: events.map((e) => e.seq) }, eventAt: (seq) => events.find((e) => e.seq === seq), snapshotEvents: () => [...events], append(type, data) { const e = { seq: events.length + 1, type, data }; events.push(e); return e; } };
  return { events, turns, session };
}
function storage(seed = []) {
  const summaries = [...seed];
  const vectors = [];
  return {
    values: { summaries, vectors },
    async summaries() { return [...summaries]; },
    async vectors() { return [...vectors]; },
    async appendSummary(row) { summaries.push(row); return true; },
    async appendVector(row) { vectors.push(row); return true; },
    async writeVectorMeta() {},
    async appendLedger(e) { (this.ledgers ??= []).push(e); },
  };
}
function config() {
  return { summary: { maxAttempts: 2, hardMaxChars: 256, promptVersion: 'L', provider: 'fake', model: 'fake' }, sourceView: { userChars: 4000, assistantChars: 5000, toolChars: 1500, totalChars: 16000, userSourceKinds: ['user'] }, vector: { model: 'BGE', dimensions: 512 } };
}
function batchFor({ events, turns, session }, start, end, store, provider, embedder = async () => vec()) {
  return createUnifiedFoldBatch({ sessionId: 's1', session, start, end, events, turns, config: config(), provider, embedder, storage: store, stagingDir: null });
}
const okProvider = (calls = { n: 0 }) => async ({ turn }) => { calls.n += 1; return { text: `L-${turn.turnId}`, provider: 'fake', model: 'fake' }; };

test('no fold: zero provider and zero storage writes', async () => {
  const f = fixture(); const calls = { n: 0 }; const store = storage();
  const batch = batchFor(f, 1, 2, store, okProvider(calls));
  assert.equal(calls.n, 0); assert.equal(store.values.summaries.length, 0); assert.equal(batch.batch.status, 'prepared');
});

test('one fold: all complete turns, content hash equals index block hash', async () => {
  const f = fixture(); const store = storage(); const batch = batchFor(f, 1, 4, store, okProvider());
  const out = await batch.summarize(); assert.equal(out.summary.length, 2);
  assert.equal(batch.batch.records.length, 2);
  for (const row of batch.batch.records) assert.equal(row.summary.blockSha256, sha256(out.summary.find((b) => b.text.includes(row.summary.turnId)).text));
  await batch.commit({ compactionId: 'c1' });
  assert.equal(store.values.summaries.length, 2); assert.equal(store.values.vectors.length, 2);
  assert.equal(store.values.summaries.every((s) => s.availableCutoff === 4), true);
});

test('no super.summarize and no extra gist', async () => {
  const source = (await import('node:fs')).readFileSync(new URL('../src/fold/unified-fold.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /super\.summarize|COMPACTION_INSTRUCTION|compacted-summary/);
  const f = fixture(); const batch = batchFor(f, 1, 4, storage(), okProvider());
  const out = await batch.summarize(); assert.equal(out.summary.length, 2); assert.equal(out.summary.every((b) => b.text.startsWith('[folded turn')), true);
});

test('two folds: second only adds new turns; old vectors unchanged', async () => {
  const f = fixture(); const store = storage(); const p1 = okProvider();
  const b1 = batchFor(f, 1, 2, store, p1); await b1.summarize(); await b1.commit({ compactionId: 'c1' });
  const old = store.values.vectors.map((v) => JSON.stringify(v));
  const p2 = okProvider();
  const b2 = createUnifiedFoldBatch({ sessionId: 's1', session: f.session, start: 3, end: 6, events: f.events, turns: f.turns, config: config(), provider: p2, embedder: async () => vec(), storage: store, stagingDir: null });
  const out = await b2.summarize(); await b2.commit({ compactionId: 'c2' });
  assert.equal(p2.n ?? 1, 1); assert.equal(out.summary.length, 2);
  assert.deepEqual(store.values.vectors.slice(0, 1).map((v) => JSON.stringify(v)), old);
  assert.equal(store.values.summaries.length, 3);
});

test('commit is idempotent; duplicate commit adds nothing', async () => {
  const f = fixture(); const store = storage(); const batch = batchFor(f, 1, 4, store, okProvider());
  await batch.summarize(); const a = await batch.commit({ compactionId: 'c' }); const b = await batch.commit({ compactionId: 'c' });
  assert.equal(a.committed, true); assert.equal(b.duplicate, true); assert.equal(store.values.summaries.length, 2); assert.equal(store.values.vectors.length, 2);
});

test('an open Host turn remains protected and fails before write', async () => {
  const rows = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    event(2, 'user/message', 'peer', { kind: 'peer' }),
    event(3, 'assistant/message', 'step one'),
    event(4, 'assistant/message', 'step two'),
  ];
  const hostTurns = buildTurnsFromEvents('s1', rows);
  const session = { id: 's1', surface: { nodes: [2, 3, 4] }, eventAt: (seq) => rows.find((row) => row.seq === seq), snapshotEvents: () => [...rows] };
  const store = storage();
  const batch = batchFor({ events: rows, turns: hostTurns, session }, 2, 3, store, okProvider());
  await assert.rejects(batch.prepare(), /open partial/);
  assert.equal(store.values.summaries.length, 0); assert.equal(store.values.vectors.length, 0);
});

test('a newer projection inside the positional range is residual, not outside fold', async () => {
  const f = fixture(); const store = storage(); const calls = { n: 0 };
  f.events.push(event(99, 'user/message', 'old summary', { kind: 'compaction' }));
  f.session.surface.nodes = [1, 99, 2];
  const batch = batchFor(f, 1, 2, store, okProvider(calls));
  const plan = await batch.prepare();
  assert.equal(plan.skippedResidual, 1);
  assert.deepEqual(plan.skipped[0], { seq: 99, reason: 'surface-projection' });
  assert.equal(plan.partialHOLD.length, 0);
  assert.deepEqual(plan.missing, []);
  assert.deepEqual(plan.outside, []);
  assert.equal(plan.selected.length, 1);
  const out = await batch.summarize();
  assert.equal(out.summary.length, 1);
  assert.equal(calls.n, 1);
});

test('Host turn markers keep peer messages together and use content boundaries', () => {
  const rows = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    event(2, 'user/message', 'peer one', { kind: 'peer' }),
    event(3, 'user/message', 'peer two', { kind: 'peer' }),
    event(4, 'assistant/message', 'answer'),
    { seq: 5, type: 'turn/end', data: { turn: 1 } },
    { seq: 6, type: 'turn/start', data: { turn: 2 } },
    event(7, 'user/message', 'next peer', { kind: 'peer' }),
    event(8, 'assistant/message', 'open answer'),
  ];
  const built = buildTurnsFromEvents('s1', rows);
  assert.equal(built.length, 2);
  assert.equal(built[0].turnId, 'turn-000002');
  assert.deepEqual(built[0].boundarySeqs, [2, 4]);
  assert.equal(built[0].closed, true);
  assert.equal(built[1].turnId, 'turn-000007');
  assert.equal(built[1].closed, false);
});

test('partial old turn reuses an exact existing summary without another provider call', async () => {
  const f = fixture(); const turn = f.turns[0];
  const existing = { sessionId: 's1', turnId: turn.turnId, seqStart: turn.seqStart, seqEnd: turn.seqEnd, rawTextSha256: turn.rawTextSha256, summaryText: 'old-L', summarySha256: sha256('old-L'), availableCutoff: 2 };
  const store = storage([existing]); const calls = { n: 0 };
  const batch = batchFor(f, 1, 1, store, okProvider(calls));
  const plan = await batch.prepare();
  assert.equal(plan.partialReused, 1);
  assert.equal(plan.partialHOLD.length, 0);
  const out = await batch.summarize();
  assert.equal(out.summary.length, 1);
  assert.match(out.summary[0].text, /old-L/);
  assert.equal(calls.n, 0);
});

test('partial old turn reuses multiple chunks only when raw offsets and hashes match', async () => {
  const f = fixture(); const turn = f.turns[0];
  const chunks = [
    { chunkId: 'a', seqStart: 1, seqEnd: 1, eventOffsets: [{ seq: 1, start: 0, end: 2 }], rawTextSha256: sha256('u1'), summaryText: 'UA', summarySha256: sha256('UA') },
    { chunkId: 'b', seqStart: 2, seqEnd: 2, eventOffsets: [{ seq: 2, start: 0, end: 2 }], rawTextSha256: sha256('a1'), summaryText: 'AA', summarySha256: sha256('AA') },
  ].map((row) => ({ ...row, sessionId: 's1', turnId: turn.turnId, availableCutoff: 2 }));
  const store = storage(chunks); const calls = { n: 0 };
  const batch = batchFor(f, 1, 1, store, okProvider(calls));
  const plan = await batch.prepare();
  assert.equal(plan.partialReused, 1);
  assert.equal(plan.selected[0].existingChunks.length, 2);
  const out = await batch.summarize();
  assert.equal(out.summary.length, 2);
  assert.equal(calls.n, 0);
  const stale = storage([{ ...chunks[0], rawTextSha256: sha256('changed') }]);
  const regeneratedCalls = { n: 0 };
  const regenerated = batchFor(f, 1, 1, stale, okProvider(regeneratedCalls));
  const repaired = await regenerated.summarize();
  assert.equal(regeneratedCalls.n, 1);
  assert.match(repaired.summary[0].text, /L-turn-000001/);
});

test('a Host turn does not reuse a stale partial summary by turnId alone', async () => {
  const rows = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    event(2, 'user/message', 'peer one', { kind: 'peer' }),
    event(3, 'user/message', 'peer two', { kind: 'peer' }),
    event(4, 'assistant/message', 'answer'),
    { seq: 5, type: 'turn/end', data: { turn: 1 } },
  ];
  const hostTurns = buildTurnsFromEvents('s1', rows);
  const session = { id: 's1', surface: { nodes: [2, 3, 4] }, eventAt: (seq) => rows.find((row) => row.seq === seq), snapshotEvents: () => [...rows] };
  const stale = storage([{ sessionId: 's1', turnId: 'turn-000002', seqStart: 2, seqEnd: 3, rawTextSha256: 'old-half', summaryText: 'half', summarySha256: sha256('half') }]);
  const calls = { n: 0 };
  const batch = batchFor({ events: rows, turns: hostTurns, session }, 2, 4, stale, okProvider(calls));
  const plan = await batch.prepare();
  assert.equal(plan.selected[0].existingChunks.length, 0);
  const out = await batch.summarize();
  assert.equal(calls.n, 1);
  assert.match(out.summary[0].text, /L-turn-000002/);
});

test('provider failure retains staging and writes no active/summary', async () => {
  const f = fixture(); const store = storage(); const batch = batchFor(f, 1, 4, store, async () => ({ text: '', provider: 'fake', model: 'fake' }));
  await assert.rejects(batch.summarize(), /no valid L/);
  await batch.fail(new Error('provider down'));
  assert.equal(store.values.summaries.length, 0); assert.equal(store.values.vectors.length, 0);
  assert.equal(store.ledgers?.some((x) => x.kind === 'unified-fold-failed'), true);
});

test('existing summary with missing vector uses embedder only', async () => {
  const f = fixture(); const turn = f.turns[0];
  const existing = { sessionId: 's1', turnId: turn.turnId, seqStart: turn.seqStart, seqEnd: turn.seqEnd, rawTextSha256: turn.rawTextSha256, summaryText: 'old-L', summarySha256: sha256('old-L'), availableCutoff: 2, blockText: 'old', blockSha256: sha256('old') };
  const store = storage([existing]); const calls = { n: 0 }; let embedded = 0;
  const batch = batchFor(f, 1, 2, store, okProvider(calls), async () => { embedded += 1; return vec(); });
  await batch.summarize(); await batch.commit({ compactionId: 'c' });
  assert.equal(calls.n, 0); assert.equal(embedded, 1); assert.equal(store.values.vectors.length, 1);
});

test('new session first fold is searchable without seed', async () => {
  const f = fixture(); const store = storage(); const batch = batchFor(f, 1, 4, store, okProvider());
  await batch.summarize(); await batch.commit({ compactionId: 'c' });
  assert.equal(store.values.summaries.length, 2); assert.equal(store.values.vectors.length, 2);
});

test('blocks include all selected turns, no ping budget omission', async () => {
  const f = fixture(); const batch = batchFor(f, 1, 6, storage(), okProvider());
  const out = await batch.summarize();
  assert.equal(out.summary.length, 3);
  assert.deepEqual(f.turns.map((t) => out.summary.some((b) => b.text.includes(t.turnId))), [true, true, true]);
});

test('content blocks have one stable hash for the whole batch', async () => {
  const f = fixture(); const batch = batchFor(f, 1, 4, storage(), okProvider());
  const out = await batch.summarize(); assert.match(unifiedContentHash(out.summary), /^[0-9a-f]{64}$/);
});

test('real host transaction shape: start -> summary -> replace -> end -> commit', async () => {
  const f = fixture(); const store = storage(); const session = f.session;
  const transaction = { start: session.append('compaction/start', { compactionId: 'tx1', turn: 1 }), summary: null, end: null };
  const batch = batchFor(f, 1, 4, store, okProvider());
  const out = await batch.summarize();
  transaction.summary = session.append('compaction/summary', { compactionId: 'tx1', summary: out.summary, shadowedRange: { start: 1, end: 4 } });
  session.append('user/message', { message: { content: out.summary } }, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 4 } });
  transaction.end = session.append('compaction/end', { compactionId: 'tx1' });
  const committed = await batch.commit({ compactionId: 'tx1' });
  assert.equal(transaction.summary.type, 'compaction/summary');
  assert.equal(transaction.end.type, 'compaction/end');
  assert.equal(committed.committed, true);
  assert.equal(store.values.summaries.length, 2);
});

test('pending index commit recovers without provider', async () => {
  const f = fixture(); const store = storage(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-pending-'));
  let fail = true; let calls = 0;
  const adapter = {
    summaries: () => store.summaries(), vectors: () => store.vectors(),
    async commitBatch(rows) { if (fail) throw new Error('index down'); for (const r of rows) { if (r.source === 'generated') await store.appendSummary(r.summary); if (r.vector) await store.appendVector({ turnId: r.summary.turnId, summarySha256: r.summary.summarySha256, vector: r.vector }); } return { mode: 'test' }; },
    appendLedger: (e) => store.appendLedger(e),
  };
  const batch = createUnifiedFoldBatch({ sessionId: 's1', session: f.session, start: 1, end: 2, events: f.events, turns: f.turns, config: config(), provider: async () => { calls += 1; return { text: 'L', provider: 'f', model: 'f' }; }, embedder: async () => vec(), storage: store, indexAdapter: adapter, stagingDir: dir });
  await batch.summarize(); const first = await batch.commit({ compactionId: 'p1' }); assert.equal(first.committed, false); assert.equal(fs.existsSync(path.join(dir, '1-2.pending.json')), true);
  fail = false; const rec = await recoverUnifiedPending({ indexAdapter: adapter, storage: store, stagingDir: dir });
  assert.equal(rec.recovered, 1); assert.equal(calls, 1); assert.equal(store.values.summaries.length, 1);
});

test('pending recovery keeps every chunk of a multi-chunk turn', async () => {
  const f = fixture(); const turn = f.turns[0];
  const a = { sessionId: 's1', turnId: turn.turnId, chunkId: 'a', seqStart: 1, seqEnd: 1, rawTextSha256: 'a', summaryText: 'La', summarySha256: sha256('La'), availableCutoff: 2 };
  const b = { sessionId: 's1', turnId: turn.turnId, chunkId: 'b', seqStart: 2, seqEnd: 2, rawTextSha256: 'b', summaryText: 'Lb', summarySha256: sha256('Lb'), availableCutoff: 2 };
  const store = storage([a, b]); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-multipending-'));
  let fail = true;
  const adapter = {
    summaries: () => store.summaries(),
    vectors: () => [{ turnId: turn.turnId, chunkId: 'a', summarySha256: a.summarySha256 }, { turnId: turn.turnId, chunkId: 'b', summarySha256: b.summarySha256 }],
    async commitBatch(rows) { if (fail) throw new Error('index down'); return { mode: 'test', rows: rows.length }; },
    appendLedger: (e) => store.appendLedger(e),
  };
  const batch = createUnifiedFoldBatch({ sessionId: 's1', session: f.session, start: 1, end: 2, events: f.events, turns: f.turns, config: config(), provider: async () => { throw new Error('provider must not run'); }, embedder: async () => vec(), storage: store, indexAdapter: adapter, stagingDir: dir });
  const out = await batch.summarize(); assert.equal(out.summary.length, 2); assert.equal(batch.batch.records.length, 2);
  const first = await batch.commit({ compactionId: 'p2' }); assert.equal(first.committed, false);
  const pending = JSON.parse(fs.readFileSync(path.join(dir, '1-2.pending.json'), 'utf8')); assert.equal(pending.records.length, 2);
  fail = false; const rec = await recoverUnifiedPending({ indexAdapter: adapter, storage: store, stagingDir: dir });
  assert.equal(rec.recovered, 1); assert.equal(fs.existsSync(path.join(dir, '1-2.pending.json')), false);
});
