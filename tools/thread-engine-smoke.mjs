/**
 * Real engine save smoke: constructs ContinuityEngine against the host
 * compaction packages, a session-shaped fake with the real pairing predicates,
 * and exercises prepareSave + saveThread. This is intentionally outside the
 * package: it needs the desktop runtime's @deepseek-ai packages.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContinuityEngine } from '../src/engine.mjs';
import { ThreadsCore } from '../src/threads-core.mjs';
import { getSession, readRules, rulesFile, updateSession } from '../src/threads-store.mjs';
import { readTags } from '../src/tags-store.mjs';
import { findTagSeqs } from '../src/tags.mjs';
import { readFolds } from '../src/folds-store.mjs';
import { writeFile } from 'node:fs/promises';

const home = await mkdtemp(join(tmpdir(), 'dsh-engine-smoke-'));
process.env.DSH_CONTINUITY_HOME = home;

function makeSession() {
  const events = [];
  const nodes = [];
  const base = 1_700_000_000_000;
  const push = (type, data, options = {}) => {
    const event = {
      seq: events.length,
      type,
      time: base + events.length * 60_000,
      data,
      ...(options.surfaceOp === undefined ? {} : { surfaceOp: options.surfaceOp }),
      ...(options.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: options.sourceEventSeqs }),
    };
    events.push(event);
    if (options.surfaceOp !== undefined && (type === 'user/message' || type === 'assistant/message'
      || type === 'tool/result' || type === 'system/message')) {
      if (options.surfaceOp === 'append' || options.surfaceOp?.op === 'append') {
        nodes.push(event.seq);
      } else if (options.surfaceOp?.op === 'replace') {
        const startIdx = nodes.indexOf(options.surfaceOp.startSeq);
        const endIdx = nodes.indexOf(options.surfaceOp.endSeq);
        if (startIdx < 0 || endIdx < startIdx) throw new Error('fake replace range not in surface');
        nodes.splice(startIdx, endIdx - startIdx + 1, event.seq);
      }
    }
    return event;
  };
  const session = {
    id: 'session-engine-smoke',
    header: { agentPreset: 'continuity' },
    get seq() { return events.length; },
    surface: { nodes },
    eventAt: (seq) => events[Number(seq)],
    snapshotEvents: () => events.slice(),
    requestHeader: () => ({ config: { provider: 'test', model: 'test', maxTokens: 0 }, tools: [] }),
    deriveEventMessage: (event) => {
      if (event?.type === 'system/message') return { role: 'system', content: [{ type: 'text', text: 'sys' }] };
      if (event?.type === 'user/message') return { role: 'user', content: [{ type: 'text', text: 'u' }] };
      if (event?.type === 'assistant/message') return { role: 'assistant', content: [{ type: 'text', text: 'a' }] };
      return null;
    },
    append: push,
  };
  // system head + prior turn + current open turn
  push('system/message', { content: [{ type: 'text', text: 'sys' }] }, { surfaceOp: 'append' });
  push('turn/start', { turn: 1 });
  push('user/message', { content: [{ type: 'text', text: 'old user' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  push('assistant/message', { message: { content: [{ type: 'text', text: 'old answer' }] } }, { surfaceOp: 'append' });
  push('turn/end', { turn: 1 });
  push('turn/start', { turn: 2 });
  push('user/message', { content: [{ type: 'text', text: 'current' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  push('assistant/message', { message: { content: [{ type: 'text', text: 'tool step' }] } }, { surfaceOp: 'append' });
  return { session, nodes, events };
}

const { session } = makeSession();
const meter = {
  measure: (value) => ({
    totalTokens: value.surface.nodes.length * 10,
    surfaceTokens: value.surface.nodes.length * 10,
    nodes: value.surface.nodes.map((seq) => ({ seq, tokens: 10, heuristicTokens: 10 })),
  }),
  estimateMessage: () => 10,
};
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tokenMeter: meter,
  reflect: { provide() {}, get() { return undefined; } },
  on() {},
  get: () => undefined,
  inject(_deps, fn) { if (typeof fn === 'function') fn(this); },
  effect(fn) { return fn(); },
};
const engine = new ContinuityEngine(ctx, {
  compactionBasic: { auto: false },
  provenance: { header: true, standingConvention: false },
  policy: {},
});
const agent = { session, options: { provider: 'test', model: 'test' } };
const prepared = await engine.prepareSave(agent, {
  label: 'T1 smoke',
  why: 'verify engine save',
  next: 'continue',
  fromSeq: 2,
  toSeq: 3,
});
assert.equal(prepared.thread.label, 'T1 smoke');
assert.equal(prepared.thread.seqStart, 2);
assert.equal(prepared.thread.seqEnd, 3);
const result = await engine.saveThread(agent, {}, undefined, { thread: prepared.thread });
assert.equal(result.ok, true);
assert.equal(result.seqStart, 2);
assert.equal(result.seqEnd, 3);
assert.ok(result.gistSeq > 0);
const state = await getSession(session.id);
assert.equal(state.threads.length, 1);
assert.equal(state.threads[0].id, result.id);
assert.equal(state.activeId, null);
const summary = session.snapshotEvents().find((event) => event.type === 'compaction/summary');
assert.ok(summary, 'compaction summary exists');
assert.match(JSON.stringify(summary.data.summary), /T1 smoke/);
const replacement = session.snapshotEvents().find((event) => event.type === 'user/message' && event.surfaceOp?.op === 'replace');
assert.ok(replacement, 'replacement user message exists');
assert.equal(replacement.surfaceOp.startSeq, 2);
assert.equal(replacement.surfaceOp.endSeq, 3);
assert.ok(replacement.sourceEventSeqs.includes(2));
assert.ok(replacement.sourceEventSeqs.includes(3));
assert.equal(
  session.snapshotEvents().filter((event) => event.type === 'compaction/prune').length,
  0,
  'save must not append a post-replacement prune (that corrupts v4 surface spans)',
);

// Stage 2/3: queue a load through the real Core, commit at the pre-step,
// verify active, pins, and per-turn active/rules injection.
const core = new ThreadsCore({
  agent,
  sessionQuery: { readSession: async () => ({ events: session.snapshotEvents() }) },
  backend: null,
});
const load = await core.load({ id: result.id, budgetTokens: 1000 });
assert.equal(load.pending, true);
assert.equal(load.injected, 2);
await engine.processPendingThread(agent);
const active = await core.active();
assert.equal(active.id, result.id);
const loaded = (await getSession(session.id)).threads.find((thread) => thread.id === result.id);
assert.ok(loaded.loadSeq > 0);
const pins = await engine.threadPinSeqs(agent);
assert.equal(pins.has(loaded.loadSeq), true);

agent.lastTurn = 2;
await engine.injectThreadContext(agent);
const line = session.snapshotEvents().find((event) => event.type === 'user/message'
  && JSON.stringify(event.data).includes('[线] 当前'));
assert.ok(line, 'active line injected');
await writeFile(rulesFile(), '## rule from smoke\n## load first\n', 'utf8');
agent.lastTurn = 3;
await engine.injectThreadContext(agent);
assert.match((await readRules()).text, /rule from smoke/);
const ruleLine = session.snapshotEvents().filter((event) => event.type === 'user/message'
  && JSON.stringify(event.data).includes('rule from smoke')).at(-1);
assert.ok(ruleLine, 'habits summary injected per turn');

// Attach a second segment to the same thread, through the real Core and the
// real engine commit. This is the acceptance path: one thread, two segments.
session.append('turn/end', { turn: 2 });
session.append('turn/start', { turn: 3 });
session.append('user/message', { content: [{ type: 'text', text: 'new user' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
session.append('assistant/message', { message: { content: [{ type: 'text', text: 'new answer' }] } }, { surfaceOp: 'append' });
session.append('turn/end', { turn: 3 });
session.append('turn/start', { turn: 4 });
session.append('user/message', { content: [{ type: 'text', text: 'current 4' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
const appendCore = new ThreadsCore({
  agent,
  sessionQuery: { readSession: async () => ({ events: session.snapshotEvents() }) },
  backend: { prepareSave: (value, saveArgs) => engine.prepareSave(value, saveArgs) },
});
const labelPrepared = await engine.prepareSave(agent, {
  label: 'BROKEN',
  why: 'label check',
  next: 'continue',
  threadId: result.id,
  fromSeq: 6,
  toSeq: 7,
});
assert.equal(labelPrepared.thread.label, 'T1 smoke');
const relabelPrepared = await engine.prepareSave(agent, {
  label: 'RENAMED',
  why: 'label check',
  next: 'continue',
  threadId: result.id,
  fromSeq: 6,
  toSeq: 7,
  relabel: true,
});
assert.equal(relabelPrepared.thread.label, 'RENAMED');

const appendReceipt = await appendCore.save({
  label: 'T1 smoke',
  why: 'second segment',
  next: 'continue second',
  threadId: result.id,
  fromSeq: 6,
  toSeq: 7,
});
assert.equal(appendReceipt.mode, 'append');
assert.equal(appendReceipt.segment, 2);
assert.equal(appendReceipt.segments, 2);
assert.match(appendReceipt.receipt, /^saved into .* · segment 2 · seq /);
await engine.processPendingThread(agent);
const afterAppend = await getSession(session.id);
assert.equal(afterAppend.threads.length, 1);
assert.equal(afterAppend.threads[0].id, result.id);
assert.equal(afterAppend.threads[0].segments.length, 2);
assert.equal(afterAppend.activeId, result.id);
assert.equal(afterAppend.pending, null);
const appendedSummary = session.snapshotEvents().filter((event) => event.type === 'compaction/summary').at(-1);
assert.match(JSON.stringify(appendedSummary.data.summary), /segment 2\/2/);
const afterList = await appendCore.list();
assert.equal(afterList.length, 1);
assert.equal(afterList[0].segments, 2);
assert.match(afterList[0].display, /· 2 段 · 最近 /);
assert.equal((await appendCore.active()).segments, 2);

// Unknown threadId: rejected before any pending/gist is written.
const beforeUnknown = await getSession(session.id);
await assert.rejects(
  () => appendCore.save({ label: 'X', why: 'Y', next: 'Z', threadId: 't-missing' }),
  /unknown threadId t-missing/,
);
const afterUnknown = await getSession(session.id);
assert.deepEqual(afterUnknown, beforeUnknown);

// Range/select load and the cheap scan, through the real engine.
const rangeLoad = await appendCore.load({
  id: result.id,
  fromSeq: 6,
  toSeq: 7,
  select: [6, 7],
  budgetTokens: 1000,
});
assert.equal(rangeLoad.ok, true);
assert.deepEqual(rangeLoad.segs, [6, 7]);
assert.equal(rangeLoad.injected, 2);
assert.ok(rangeLoad.tokens < 1000);
await engine.processPendingThread(agent);
const afterRangeLoad = await getSession(session.id);
assert.equal(afterRangeLoad.activeId, result.id);
assert.equal(afterRangeLoad.pending, null);
assert.ok(afterRangeLoad.threads[0].loadSeq > 0);
const scan = await appendCore.scan({ fromSeq: 2, toSeq: 7 });
assert.ok(scan.length > 0);
assert.ok(scan.every((item) => item.head.length <= 160));
assert.ok(scan.every((item) => !item.head.includes('[reasoning]')));

// P1/P3/P4: a tag load must not move the active thread, and its receipt uses
// one display name.
const tagWrite = await appendCore.tag({ seqs: [2, 3], id: 'T2', label: 'Avatar' });
assert.equal(tagWrite.label, 'Avatar');
const tagLoad = await appendCore.load({ id: 'T2', budgetTokens: 1000 });
assert.equal(tagLoad.mode, 'tag');
assert.equal(tagLoad.active, false);
const tagPending = await getSession(session.id);
assert.match(tagPending.pending.text, /^\[取\] Avatar/);
assert.doesNotMatch(tagPending.pending.text, /Avatar · Avatar/);
const tagFind = await appendCore.find({ id: 'T2' });
assert.deepEqual(tagFind.folded, [2, 3]);
const foldedLoad = await appendCore.load({ id: 'T2', first: 5, last: 0 });
assert.equal(foldedLoad.ok, true);
const foldedPending = await getSession(session.id);
assert.match(foldedPending.pending.text, /\[已折叠于 gist seq=\d+\]/);
await engine.processPendingThread(agent);
const foldRecord = await readFolds(session.id);
assert.ok(foldRecord.folds.some((fold) => fold.from <= 2 && fold.to >= 3));
await engine.processPendingThread(agent);
const afterTagLoad = await getSession(session.id);
assert.equal(afterTagLoad.activeId, result.id);
const tagIndex = await appendCore.tags();
assert.equal(tagIndex.tags.find((row) => row.id === result.id).active, true);
assert.equal(tagIndex.tags.find((row) => row.id === 'T2').display, 'Avatar');
assert.equal(tagIndex.tags.find((row) => row.id === 'T2').active, false);
agent.lastTurn = 5;
await engine.injectThreadContext(agent);
const activeLineAfterTag = session.snapshotEvents().filter((event) => event.type === 'user/message'
  && JSON.stringify(event.data).includes('[线] 当前')).at(-1);
assert.match(JSON.stringify(activeLineAfterTag.data), /T1 smoke/);
assert.match(JSON.stringify(activeLineAfterTag.data), /\[标签\] 当前/);

// Automatic turn tagging: the active thread id is T, or T0.
await engine.autoTagCompletedTurn(agent);
const tagsRead = await readTags();
const tagged = findTagSeqs({ tags: tagsRead.state, id: result.id, events: session.snapshotEvents() });
assert.ok(tagged.count > 0, 'auto tag finds messages under the active thread id');
assert.ok(tagsRead.state.runs.some((run) => run[2] === result.id));
await engine.autoTagCompletedTurn(agent);
const tagsReadAgain = await readTags();
assert.equal(
  tagsReadAgain.state.runs.filter((run) => run[2] === result.id).length,
  tagsRead.state.runs.filter((run) => run[2] === result.id).length,
);

// No active thread -> T0.
await updateSession(session.id, (current) => {
  current.activeId = null;
  current.threads = current.threads.map((thread) => ({ ...thread, active: false }));
  return current;
});
session.append('turn/start', { turn: 5 });
session.append('user/message', { content: [{ type: 'text', text: 'unassigned turn' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
session.append('turn/end', { turn: 5 });
await engine.autoTagCompletedTurn(agent);
const t0Tags = await readTags();
const t0Run = t0Tags.state.runs.find((run) => run[2] === 'T0');
assert.ok(t0Run, 'turns without an active thread fall back to T0');
const t0Found = findTagSeqs({ tags: t0Tags.state, id: 'T0', events: session.snapshotEvents() });
assert.ok(t0Found.count > 0);

// Alias: tag metadata sets the thread alias; the auto tag writes the canonical
// thread id, tags()/[标签] display T9, and find(T9) resolves to the canonical.
await updateSession(session.id, (current) => {
  current.activeId = result.id;
  current.threads = current.threads.map((thread) => ({ ...thread, active: thread.id === result.id }));
  return current;
});
const aliasSet = await appendCore.tag({ id: result.id, alias: 'T9' });
assert.equal(aliasSet.alias, 'T9');
assert.equal((await getSession(session.id)).threads[0].alias, 'T9');
session.append('turn/start', { turn: 6 });
session.append('user/message', { content: [{ type: 'text', text: 'alias turn' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
session.append('turn/end', { turn: 6 });
agent.lastTurn = 6;
await engine.autoTagCompletedTurn(agent);
const aliasTags = await readTags();
assert.ok(aliasTags.state.runs.some((run) => run[2] === result.id), 'auto tag writes the canonical id');
assert.equal(aliasTags.state.runs.some((run) => run[2] === 'T9'), false);
const aliasIndex = await appendCore.tags();
const aliasRow = aliasIndex.tags.find((row) => row.id === result.id);
assert.equal(aliasRow.display, 'T9');
assert.equal(aliasRow.alias, 'T9');
assert.equal(aliasRow.active, true);
assert.equal(aliasIndex.tags.some((row) => row.id === 'T9'), false);
const aliasFind = await appendCore.find({ id: 'T9' });
const canonicalFind = await appendCore.find({ id: result.id });
assert.deepEqual(aliasFind.seqs, canonicalFind.seqs);
assert.equal(aliasFind.count, canonicalFind.count);
const aliasPage = await appendCore.find({ id: 'T9', limit: 1 });
assert.equal(aliasPage.count, aliasFind.count);
assert.ok(aliasPage.seqs.length <= 1);
agent.lastTurn = 7;
await engine.injectThreadContext(agent);
const aliasLine = session.snapshotEvents().filter((event) => event.type === 'user/message'
  && JSON.stringify(event.data).includes('[标签]')).at(-1);
assert.match(JSON.stringify(aliasLine.data), /\[标签\] 当前 T9/);
const t0AfterAlias = (await appendCore.tags()).tags.find((row) => row.id === 'T0');
const t0AfterFind = await appendCore.find({ id: 'T0' });
assert.equal(t0AfterAlias.events, t0AfterFind.count);

// Gist header T is covered by the unit tests; the engine prepare path sets it
// from the same tagCoverageForRange() result.

console.log(JSON.stringify({
  ok: true,
  result,
  appendReceipt,
  rangeLoad,
  scan,
  tagged,
  tags: tagsRead.state,
  t0Run,
  t0Found,
  afterAppend: afterAppend.threads[0],
  afterRangeLoad: afterRangeLoad.threads[0],
  afterList,
  load,
  active,
  loadSeq: loaded.loadSeq,
  pins: [...pins],
  surface: session.surface.nodes,
  summarySeq: summary.seq,
  replacementSeq: replacement.seq,
  thread: state.threads[0],
}, null, 2));
await rm(home, { recursive: true, force: true });
