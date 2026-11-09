import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeLine,
  activePinSeqsFromState,
  activeView,
  contextMessage,
  estimateTextTokens,
  gateMessage,
  listView,
  quoteSelected,
  scanEvents,
  selectLoadSegment,
  selectSaveRange,
  summarizeRules,
  tagStatusLine,
  threadContextText,
  threadGistText,
  threadLoadText,
  truncateToTokens,
  userMessage,
} from '../src/threads.mjs';
import { getSession, readRules, rulesFile, threadsFile, updateSession } from '../src/threads-store.mjs';
import { makeApi, setGatesEnabledForTests, ThreadsCore } from '../src/threads-core.mjs';
import { createThreadsTool, apply as applyThreadsTool } from '../src/threads-tool.mjs';

const home = await mkdtemp(join(tmpdir(), 'dsh-threads-'));
process.env.DSH_CONTINUITY_HOME = home;
// 假 session 没有 turn/事件：关掉四道闸，闸本身另有 turn-gate/turngap 测试。
setGatesEnabledForTests(false);

after(async () => {
  await rm(home, { recursive: true, force: true });
});
function event(seq, type = 'user/message', text = `message ${seq}`, extra = {}) {
  return {
    seq,
    type,
    time: 1_700_000_000_000 + seq * 60_000,
    data: type === 'tool/result'
      ? { message: { content: [{ type: 'text', text }] } }
      : { content: [{ type: 'text', text }], source: { kind: 'user' } },
    ...extra,
  };
}

function fakeSession(nodes, { turnStart = null, messages = true } = {}) {
  const bySeq = new Map();
  for (const seq of nodes) {
    bySeq.set(seq, event(seq, seq === nodes[0] ? 'system/message' : 'user/message', String(seq)));
  }
  if (turnStart !== null) bySeq.set(turnStart, { seq: turnStart, type: 'turn/start', time: 1_700_000_000_000, data: { turn: 1 } });
  return {
    id: 'session-test',
    seq: Math.max(...nodes, turnStart ?? 0) + 1,
    surface: { nodes },
    eventAt: (seq) => bySeq.get(Number(seq)),
    deriveEventMessage: (value) => (messages ? { role: 'user', content: [{ type: 'text', text: String(value?.seq ?? '') }] } : null),
  };
}

function noopPairing() {
  return { before: () => true, after: () => true };
}

test('selectSaveRange accepts a balanced explicit range', () => {
  const nodes = [1, 2, 3, 4, 5, 6, 7, 10];
  const session = fakeSession(nodes, { turnStart: 9 });
  const range = selectSaveRange({ session, fromSeq: 2, toSeq: 4, pairing: noopPairing() });
  assert.equal(range.startSeq, 2);
  assert.equal(range.endSeq, 4);
  assert.deepEqual(range.shadowedSeqs, [2, 3, 4]);
  assert.equal(range.count, 3);
  assert.equal(range.adjusted, false);
});

test('selectSaveRange rejects an explicit cut', () => {
  const session = fakeSession([1, 2, 3, 4, 5], { turnStart: 9 });
  const pairing = { before: () => false, after: () => true };
  assert.throws(
    () => selectSaveRange({ session, fromSeq: 2, toSeq: 4, pairing }),
    /cuts a tool call\/result pair/,
  );
});

test('selectSaveRange never folds the current turn', () => {
  const session = fakeSession([1, 2, 3, 4, 5, 9, 10], { turnStart: 9 });
  assert.throws(
    () => selectSaveRange({ session, fromSeq: 2, toSeq: 10, pairing: noopPairing() }),
    /current open turn/,
  );
});

test('default save starts after the latest gist and ends before the open turn', () => {
  const nodes = [1, 2, 3, 4, 5, 6, 7, 9, 10];
  const session = fakeSession(nodes, { turnStart: 9 });
  // node 3 is a gist; node 5 is an unbalanced end that must back off.
  session.eventAt(3).data.content = [{ type: 'text', text: '[gist · log:s#seq=1-2]' }];
  const range = selectSaveRange({
    session,
    pairing: {
      before: () => true,
      after: (value, seq) => Number(seq) === 4,
    },
  });
  assert.equal(range.startSeq, 4);
  assert.equal(range.endSeq, 4);
  assert.equal(range.adjusted, true);
});

test('default save starts after the system head when there is no gist', () => {
  const session = fakeSession([1, 2, 3, 4, 5], { turnStart: 9 });
  const range = selectSaveRange({ session, pairing: noopPairing() });
  assert.equal(range.startSeq, 2);
  assert.equal(range.endSeq, 5);
});

test('default save clamps to the current T run start; explicit range is untouched', () => {
  const session = fakeSession([1, 2, 3, 4, 5, 6, 7, 9, 10], { turnStart: 9 });
  const range = selectSaveRange({
    session,
    pairing: noopPairing(),
    minStartSeq: 5,
  });
  assert.equal(range.startSeq, 5);
  assert.equal(range.endSeq, 7);
  assert.equal(range.adjusted, true);
  const explicit = selectSaveRange({
    session,
    fromSeq: 2,
    toSeq: 4,
    pairing: noopPairing(),
    minStartSeq: 5,
  });
  assert.equal(explicit.startSeq, 2);
  assert.equal(explicit.endSeq, 4);
});

test('load selection is newest-first and respects the token budget', () => {
  const events = new Map([
    [1, event(1, 'user/message', 'a'.repeat(400))],
    [2, event(2, 'assistant/message', 'b'.repeat(400))],
    [3, event(3, 'user/message', 'c'.repeat(400))],
  ]);
  const segment = selectLoadSegment({ seqs: [1, 2, 3], bySeq: events, budget: 150 });
  assert.equal(segment.missing, false);
  assert.equal(segment.selected.length, 1);
  assert.equal(segment.selected[0].seq, 3);
  assert.ok(segment.tokens >= 100);
  assert.match(quoteSelected(segment.selected), /^\[user\] c/);
});

test('load selection reports missing raw instead of guessing', () => {
  const segment = selectLoadSegment({ seqs: [1, 2], bySeq: new Map(), budget: 1000 });
  assert.equal(segment.missing, true);
  assert.deepEqual(segment.selected, []);
});

test('gist and load bodies carry the required fields', () => {
  const thread = {
    id: 't-1', label: 'T1 爬塔', why: '午饭', next: '先 observe', seqStart: 10, seqEnd: 20,
    spanStart: '2026-10-27T01:00:00.000Z', spanEnd: '2026-10-27T01:30:00.000Z', minutes: 30,
    archiveRef: 'log:s#seq=10-20', count: 4, sessionId: 's',
  };
  const gist = threadGistText(thread);
  assert.match(gist, /^\[thread\] T1 爬塔/);
  assert.match(gist, /下一步:先 observe/);
  assert.match(gist, /\[gist · log:s#seq=10-20/);
  const load = threadLoadText(thread, '[user] old');
  assert.match(load, /现在算在「t-1」这条线上/);
  assert.match(load, /以下是从原文取回的最后一段/);
});

test('active line and views reflect the pointer and closed count', () => {
  const state = {
    activeId: 't-1',
    threads: [
      { id: 't-1', label: 'T1 爬塔', next: '先 observe', active: true, loadSeq: 30 },
      { id: 't-2', label: 'T2 蝌蚪', active: false },
    ],
  };
  assert.match(activeLine(state), /\[工作线\] T1 爬塔/);
  assert.match(activeLine(state), /（0 段 · 0 tokens）/);
  assert.doesNotMatch(activeLine(state), /已收起/);
  const split = activeLine({
    activeId: 't-2',
    threads: [
      { id: 't-1', label: 'T1', active: true, segments: [{ tokens: 12 }, { tokens: 8 }] },
      { id: 't-2', label: 'T2 蝌蚪', active: false },
    ],
  });
  assert.match(split, /T1（2 段 · 20 tokens）（活动：T2 蝌蚪）/);
  const tagLine = tagStatusLine(state, [
    { id: 't-1', display: 'T1', label: 'T1 爬塔', threadId: 't-1' },
    { id: 'T2', display: 'T2', label: 'T2 蝌蚪' },
    { id: 'T0', display: 'T0', label: '未分类' },
  ]);
  assert.match(tagLine, /\[标签\] T1 · 另有 1 条/);
  assert.equal(tagStatusLine({ activeId: null, threads: [] }, []), '[标签] T 未定 · 另有 0 条');
  const view = activeView(state);
  assert.equal(view.id, 't-1');
  assert.equal(view.label, 'T1 爬塔');
  assert.equal(view.next, '先 observe');
  assert.equal(view.closed, 1);
  assert.equal(view.segments, 1);
  assert.match(view.display, /T1 爬塔 · 1 段 · 最近/);
  assert.equal(listView(state).length, 2);
  assert.equal(listView(state)[0].segments, 1);
  assert.match(listView(state)[0].display, /T1 爬塔 · 1 段 · 最近/);
  assert.deepEqual([...activePinSeqsFromState(state, [29, 30, 31])], [30]);
});

test('token truncation stays at the requested estimate', () => {
  const text = '中'.repeat(500);
  const cut = truncateToTokens(text, 100);
  assert.ok(estimateTextTokens(cut) <= 100);
  assert.match(cut, /truncated/);
});

test('injected context uses a registered runtime-context source', () => {
  const message = contextMessage('hello');
  assert.equal(message.role, 'user');
  assert.equal(message.source.kind, 'runtime-context');
  assert.equal(message.source.form, 'snapshot');
  assert.equal(message.source.sections[0].text, 'hello');
  assert.equal(message.content[0].text, 'hello');
});

test('gate user messages always carry source.kind', () => {
  const message = userMessage('TAG 错误');
  assert.equal(message.role, 'user');
  assert.equal(message.source.kind, 'user');
  assert.equal(message.content[0].text, 'TAG 错误');
});

test('tag-gate steer messages use a user source so steer admits them', () => {
  const message = gateMessage('[闸] TAG：');
  assert.equal(message.role, 'user');
  assert.equal(message.source.kind, 'user');
  assert.equal(message.content[0].text, '[闸] TAG：');
  assert.match(message.id, /^[0-9a-f-]{36}$/);
});

test('rules are injected as one constitution summary line plus the path, not full text', () => {
  const block = threadContextText('[工作线] 无', 'save 跨 T · find→scan→load');
  assert.match(block, /\[规则\]/);
  assert.match(block, /Continuity 自己的硬规则（AGENTS 要求必须读；只改这份，不改 AGENTS）：save 跨 T/);
  assert.match(block, /全文 ~\/\.dsh\/continuity\/rules\.md/);
  assert.equal(block.includes('先 save 再 load'), false);
  assert.equal(threadContextText('', ''), '');
  assert.match(summarizeRules('## save：跨 T\n## load：先 scan'), /save：跨 T · load：先 scan/);
});

test('habits are a separate soft summary line, not the rules line', () => {
  const block = threadContextText('[工作线] 无', '硬规则', '措辞 · 例子 · 风格');
  assert.match(block, /\[规则\].*硬规则/);
  assert.match(block, /\[习惯\] Continuity 自己的软偏好.*措辞 · 例子 · 风格/);
  assert.match(block, /habits\.md/);
  assert.match(block, /与 rules 冲突时让位/);
});

test('state is partitioned per session and survives a new read', async () => {
  await updateSession('s1', (current) => {
    current.activeId = 't1';
    current.threads = [{ id: 't1', label: 'A', active: true }];
    return current;
  });
  const s1 = await getSession('s1');
  const s2 = await getSession('s2');
  assert.equal(s1.activeId, 't1');
  assert.equal(s1.threads[0].label, 'A');
  assert.deepEqual(s2, { threads: [], activeId: null, pending: null });
  const raw = JSON.parse(await readFile(threadsFile(), 'utf8'));
  assert.equal(raw.sessions.s1.threads[0].id, 't1');
});

test('rules are read-only and absent by default', async () => {
  const before = await readRules();
  assert.equal(before.missing, true);
  await assert.rejects(access(rulesFile()));
  await mkdir(home, { recursive: true });
  await writeFile(rulesFile(), 'rule one\n', 'utf8');
  const after = await readRules();
  assert.equal(after.missing, false);
  assert.equal(after.text, 'rule one\n');
  await rm(rulesFile(), { force: true });
});

test('facade forwards all four Core methods', async () => {
  const session = {
    id: 's-facade',
    append: (type, data) => ({ type, data, seq: 99 }),
  };
  const core = new ThreadsCore({
    agent: { session },
    sessionQuery: { readSession: async () => ({ events: [] }) },
    backend: {
      prepareSave: async () => ({
        thread: {
          id: 't-facade', label: 'A', why: 'B', next: 'C', spanStart: 'x', spanEnd: 'y',
          minutes: 1, tokens: 2, seqStart: 1, seqEnd: 2, seqs: [1, 2], count: 2,
          archiveRef: 'log:s#seq=1-2', sessionId: 's-facade',
        },
      }),
    },
  });
  const api = makeApi(core);
  for (const key of ['save', 'load', 'scan', 'active', 'list']) assert.equal(typeof api[key], 'function', key);
  const save = await api.save({ label: 'A', why: 'B', next: 'C' });
  assert.equal(save.pending, true);
  assert.equal(save.id, 't-facade');
  // 回归：preflight 段曾整块抛 "home is not defined"（home 声明在闸的 try 块里），
  // 保存照样成功，于是屏幕上只剩一个 null，没人发现诊断已经瞎了。
  assert.equal(save.preflightError ?? null, null);
  assert.equal(typeof save.tagRows?.rows, 'number');
  const active = await api.active();
  assert.equal(active, null);
});

test('tool saves a pending thread without appending inside the tool call', async () => {
  const session = {
    id: 's-tool',
    append: () => { throw new Error('tool must not append'); },
  };
  const thread = {
    id: 't-tool', label: 'T', why: 'W', next: 'N', spanStart: 'x', spanEnd: 'y',
    minutes: 1, tokens: 10, seqStart: 1, seqEnd: 2, seqs: [1, 2], count: 2,
    archiveRef: 'log:s-tool#seq=1-2', sessionId: 's-tool',
    segments: [{
      fromSeq: 1, toSeq: 2, seqs: [1, 2], count: 2, spanStart: 'x', spanEnd: 'y',
      minutes: 1, tokens: 10, why: 'W', next: 'N', at: '2026-10-27T01:00:00.000Z',
      archiveRef: 'log:s-tool#seq=1-2',
    }],
  };
  const tool = createThreadsTool({
    sessionQuery: { readSession: async () => ({ events: [] }) },
    getBackend: () => ({ prepareSave: async () => ({ thread }) }),
  });
  const result = JSON.parse(await tool.execute(
    { action: 'save', label: 'T', why: 'W', next: 'N' },
    { agent: { session } },
  ));
  assert.equal(result.pending, true);
  assert.equal(result.mode, 'new');
  assert.match(result.receipt, /^saved as t-tool · seq 1\.\.2 · 10 tokens$/);
  assert.equal(result.id, 't-tool');
  const state = await getSession('s-tool');
  assert.equal(state.pending.kind, 'save');
  assert.equal(state.pending.thread.id, 't-tool');
  assert.equal(state.pending.prepared.thread.id, 't-tool');
  assert.equal(state.activeId, null);
});

test('scan lists cheap heads, excludes reasoning and synthetic context', () => {
  const longReasoning = 'r'.repeat(10_000);
  const events = [
    event(958, 'user/message', 'Coopanion 说给大肥鱼画头像，512x512，avatar.png'),
    {
      seq: 959,
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'Time sampled while preparing turn 23' }], source: { kind: 'runtime-context' } },
    },
    {
      seq: 962,
      type: 'assistant/message',
      data: { message: { content: [{ type: 'reasoning', text: longReasoning }] } },
    },
    {
      seq: 969,
      type: 'user/message',
      data: {
        content: [{ type: 'text', text: 'This is an automatically generated checkpoint condensing an earlier span' }],
        source: { kind: 'compact-checkpoint' },
      },
    },
    {
      seq: 1030,
      type: 'assistant/message',
      data: {
        message: {
          content: [
            { type: 'reasoning', text: longReasoning },
            { type: 'text', text: '**能出图。** 可以用 SVG 或 PNG，先画两三个草稿。' },
          ],
        },
      },
    },
    event(1040, 'user/message', '确认了,就是 avatar.png 那个位置；先别动现有文件，画两三个草稿。'),
    {
      seq: 1042,
      type: 'assistant/message',
      data: { message: { content: [{ type: 'reasoning', text: longReasoning }] } },
    },
  ];
  const items = scanEvents({ events, fromSeq: 958, toSeq: 1050 });
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((item) => item.seq), [958, 1030, 1040]);
  assert.ok(items.every((item) => !item.head.includes('[reasoning]')));
  assert.ok(items.every((item) => item.head.length <= 160));
  assert.ok(items.every((item) => item.role === 'user' || item.role === 'assistant'));
  assert.ok(estimateTextTokens(JSON.stringify(items)) < 1000);

  const withReasoning = scanEvents({ events, fromSeq: 958, toSeq: 1050, includeReasoning: true });
  assert.equal(withReasoning.length, 5);
  assert.ok(withReasoning.some((item) => item.seq === 962 && item.head.includes('[reasoning]')));
  assert.equal(scanEvents({ events, fromSeq: 958, toSeq: 1050, headChars: 20 })
    .every((item) => item.head.length <= 20), true);
});

test('scan action is cheap, read-only, and available through the tool', async () => {
  const events = [event(958, 'user/message', 'avatar request'), event(1040, 'user/message', 'avatar confirm')];
  const stateBefore = await getSession('s-scan');
  const core = new ThreadsCore({
    agent: { session: { id: 's-scan' } },
    sessionQuery: { readSession: async () => ({ events }) },
    backend: null,
  });
  const items = await core.scan({ fromSeq: 958, toSeq: 1050 });
  assert.deepEqual(items.map((item) => item.seq), [958, 1040]);
  assert.deepEqual(await getSession('s-scan'), stateBefore);
  const tool = createThreadsTool({ sessionQuery: { readSession: async () => ({ events }) } });
  const result = JSON.parse(await tool.execute(
    { action: 'scan', fromSeq: 958, toSeq: 1050 },
    { agent: { session: { id: 's-scan' } } },
  ));
  assert.deepEqual(result.map((item) => item.seq), [958, 1040]);
  await assert.rejects(
    () => tool.execute({ action: 'scan', fromSeq: 958 }, { agent: { session: { id: 's-scan' } } }),
    /fromSeq.*toSeq|toSeq.*required/i,
  );
});

test('load range/select injects exactly the chosen visible events', async () => {
  const events = [
    event(1030, 'user/message', 'avatar spec 1030'),
    event(1040, 'user/message', 'avatar confirm 1040'),
    {
      seq: 1041,
      type: 'assistant/message',
      data: { message: { content: [{ type: 'reasoning', text: 'x'.repeat(5000) }] } },
    },
    event(1042, 'user/message', 'avatar follow-up 1042'),
  ];
  const thread = {
    id: 't-range', label: 'Avatar', why: 'W', next: 'N', seqStart: 1030, seqEnd: 1042,
    seqs: [1030, 1040, 1041, 1042], count: 4, spanStart: '2026-10-27T01:00:00.000Z',
    spanEnd: '2026-10-27T02:00:00.000Z', minutes: 60, tokens: 5000,
    archiveRef: 'log:s-range#seq=1030-1042', sessionId: 's-range',
    segments: [{
      fromSeq: 1030, toSeq: 1042, seqs: [1030, 1040, 1041, 1042], count: 4,
      spanStart: '2026-10-27T01:00:00.000Z', spanEnd: '2026-10-27T02:00:00.000Z',
      minutes: 60, tokens: 5000, why: 'W', next: 'N', at: '2026-10-27T02:00:00.000Z',
      archiveRef: 'log:s-range#seq=1030-1042',
    }],
  };
  await updateSession('s-range', (current) => {
    current.threads = [thread];
    current.activeId = null;
    return current;
  });
  const core = new ThreadsCore({
    agent: { session: { id: 's-range' } },
    sessionQuery: { readSession: async () => ({ events }) },
    backend: null,
  });
  const selected = await core.load({ id: 't-range', fromSeq: 1030, toSeq: 1042, select: [1030, 1040] });
  assert.equal(selected.ok, true);
  assert.equal(selected.pending, true);
  assert.equal(selected.injected, 2);
  assert.deepEqual(selected.segs, [1030, 1040]);
  assert.deepEqual(selected.range, { fromSeq: 1030, toSeq: 1042 });
  assert.ok(selected.tokens < 200);
  const state = await getSession('s-range');
  assert.equal(state.pending.kind, 'load');
  assert.deepEqual(state.pending.segs, [1030, 1040]);
  assert.match(state.pending.text, /范围 1030\.\.1042 · 选择 2 条/);
  assert.match(state.pending.text, /avatar spec 1030/);
  assert.match(state.pending.text, /avatar confirm 1040/);
  assert.doesNotMatch(state.pending.text, /\[reasoning\]/);
  assert.doesNotMatch(state.pending.text, /avatar follow-up 1042/);

  const oldShape = await core.load({ id: 't-range', budgetTokens: 4000 });
  assert.equal(oldShape.ok, true);
  assert.equal(oldShape.pending, true);
  assert.deepEqual(oldShape.segs, [1030, 1040, 1042]);
  assert.equal(oldShape.range, undefined);

  const rangeOnly = await core.load({ id: 't-range', fromSeq: 1030, toSeq: 1042 });
  assert.equal(rangeOnly.ok, true);
  assert.deepEqual(rangeOnly.segs, [1030, 1040, 1042]);
  assert.deepEqual(rangeOnly.range, { fromSeq: 1030, toSeq: 1042 });
  const rangeState = await getSession('s-range');
  assert.match(rangeState.pending.text, /范围 1030\.\.1042/);
});

test('load select rejects seqs outside the thread or the range', async () => {
  await updateSession('s-range-bad', (current) => {
    current.threads = [{
      id: 't-bad', label: 'Bad', why: 'W', next: 'N', seqStart: 1, seqEnd: 2,
      seqs: [1, 2], count: 2, spanStart: 'x', spanEnd: 'y', minutes: 1, tokens: 2,
      archiveRef: 'log:s-range-bad#seq=1-2', sessionId: 's-range-bad',
      segments: [{
        fromSeq: 1, toSeq: 2, seqs: [1, 2], count: 2, spanStart: 'x', spanEnd: 'y',
        minutes: 1, tokens: 2, why: 'W', next: 'N', at: '2026-10-27T01:00:00.000Z',
        archiveRef: 'log:s-range-bad#seq=1-2',
      }],
    }];
    return current;
  });
  const core = new ThreadsCore({
    agent: { session: { id: 's-range-bad' } },
    sessionQuery: { readSession: async () => ({ events: [event(1, 'user/message', 'one'), event(2, 'user/message', 'two')] }) },
    backend: null,
  });
  const before = await getSession('s-range-bad');
  const outside = await core.load({ id: 't-bad', select: [3] });
  assert.equal(outside.ok, false);
  assert.equal(outside.reason, 'seq-not-in-thread');
  const outsideRange = await core.load({ id: 't-bad', fromSeq: 1, toSeq: 1, select: [2] });
  assert.equal(outsideRange.ok, false);
  assert.equal(outsideRange.reason, 'select-outside-range');
  assert.deepEqual(await getSession('s-range-bad'), before);
});

test('tool load queues the quote and sets the active pointer', async () => {
  const session = {
    id: 's-load',
    append: () => { throw new Error('tool must not append'); },
  };
  await updateSession('s-load', (current) => {
    current.threads = [{
      id: 't-load', label: 'L', why: 'W2', next: 'N2', spanStart: 'x', spanEnd: 'z',
      minutes: 2, tokens: 4, seqStart: 1, seqEnd: 4, seqs: [3, 4], count: 2,
      archiveRef: 'log:s-load#seq=3-4', sessionId: 's-load',
      segments: [
        {
          fromSeq: 1, toSeq: 2, seqs: [1, 2], count: 2, spanStart: 'x', spanEnd: 'y',
          minutes: 1, tokens: 2, why: 'W1', next: 'N1', at: '2026-10-27T01:00:00.000Z',
          archiveRef: 'log:s-load#seq=1-2',
        },
        {
          fromSeq: 3, toSeq: 4, seqs: [3, 4], count: 2, spanStart: 'y', spanEnd: 'z',
          minutes: 1, tokens: 2, why: 'W2', next: 'N2', at: '2026-10-27T02:00:00.000Z',
          archiveRef: 'log:s-load#seq=3-4',
        },
      ],
    }];
    return current;
  });
  const tool = createThreadsTool({
    sessionQuery: {
      readSession: async () => ({
        events: [
          event(1, 'user/message', 'one'), event(2, 'assistant/message', 'two'),
          event(3, 'user/message', 'three'), event(4, 'assistant/message', 'four'),
        ],
      }),
    },
  });
  const result = JSON.parse(await tool.execute(
    { action: 'load', id: 't-load', budgetTokens: 1000 },
    { agent: { session } },
  ));
  assert.equal(result.pending, true);
  assert.equal(result.injected, 2);
  assert.equal(result.active, true);
  assert.equal(result.segment, 2);
  assert.equal(result.segments, 2);
  const state = await getSession('s-load');
  assert.equal(state.activeId, 't-load');
  assert.equal(state.pending.kind, 'load');
  assert.equal(state.pending.segment, 2);
  assert.match(state.pending.text, /第2\/2段/);
  assert.match(state.pending.text, /现在算在「t-load」这条线上/);
  assert.match(state.pending.text, /\[user\] three/);
});

test('save with threadId appends a segment and activates the same thread', async () => {
  const session = { id: 's-append', append: () => { throw new Error('tool must not append'); } };
  const oldSegment = {
    fromSeq: 1, toSeq: 2, seqs: [1, 2], count: 2, spanStart: 'x', spanEnd: 'y',
    minutes: 10, tokens: 100, why: 'old', next: 'old next', at: '2026-10-27T01:00:00.000Z',
    archiveRef: 'log:s-append#seq=1-2',
  };
  const oldThread = {
    id: 't-append', label: 'T3', why: 'old', next: 'old next', spanStart: 'x', spanEnd: 'y',
    minutes: 10, tokens: 100, seqStart: 1, seqEnd: 2, seqs: [1, 2], count: 2,
    archiveRef: 'log:s-append#seq=1-2', sessionId: 's-append', segments: [oldSegment],
  };
  await updateSession('s-append', (current) => {
    current.threads = [oldThread];
    current.activeId = null;
    return current;
  });
  const newSegment = {
    fromSeq: 3, toSeq: 4, seqs: [3, 4], count: 2, spanStart: 'y', spanEnd: 'z',
    minutes: 5, tokens: 9800, why: 'again', next: 'continue', at: '2026-10-27T02:00:00.000Z',
    archiveRef: 'log:s-append#seq=3-4',
  };
  const preparedThread = {
    ...oldThread,
    why: 'again',
    next: 'continue',
    seqEnd: 4,
    seqs: [3, 4],
    count: 2,
    spanEnd: 'z',
    minutes: 15,
    tokens: 9900,
    active: true,
    segments: [oldSegment, newSegment],
  };
  const tool = createThreadsTool({
    sessionQuery: { readSession: async () => ({ events: [] }) },
    getBackend: () => ({
      prepareSave: async () => ({
        mode: 'append',
        thread: preparedThread,
        segment: newSegment,
        segmentIndex: 2,
        threadId: 't-append',
      }),
    }),
  });
  const result = JSON.parse(await tool.execute(
    { action: 'save', label: 'T3', why: 'again', next: 'continue', threadId: 't-append' },
    { agent: { session } },
  ));
  assert.equal(result.mode, 'append');
  assert.equal(result.id, 't-append');
  assert.equal(result.segment, 2);
  assert.equal(result.segments, 2);
  assert.equal(result.active, true);
  assert.match(result.receipt, /^saved into t-append · segment 2 · seq 3\.\.4 · 9\.8k tokens$/);
  const state = await getSession('s-append');
  assert.equal(state.activeId, 't-append');
  assert.equal(state.threads.length, 1);
  assert.equal(state.pending.mode, 'append');
  assert.equal(state.pending.prepared.thread.segments.length, 2);
});

test('save with an unknown threadId rejects without writing state', async () => {
  const before = await getSession('s-unknown');
  const tool = createThreadsTool({
    sessionQuery: { readSession: async () => ({ events: [] }) },
    getBackend: () => ({
      prepareSave: async () => { throw new Error('continuity.save: unknown threadId t-nope'); },
    }),
  });
  await assert.rejects(
    () => tool.execute(
      { action: 'save', label: 'L', why: 'W', next: 'N', threadId: 't-nope' },
      { agent: { session: { id: 's-unknown' } } },
    ),
    /unknown threadId t-nope/,
  );
  const after = await getSession('s-unknown');
  assert.deepEqual(after, before);
  assert.equal(after.pending, null);
  assert.equal(after.threads.length, 0);
});

test('old one-range threads.json is read as one segment and rewritten normalized', async () => {
  const old = {
    id: 't-old', label: 'Old', why: 'W', next: 'N', seqStart: 10, seqEnd: 20,
    seqs: [10, 20], count: 2, spanStart: '2026-10-27T01:00:00.000Z',
    spanEnd: '2026-10-27T01:30:00.000Z', minutes: 30, tokens: 100,
    archiveRef: 'log:s-old#seq=10-20', sessionId: 's-old', active: true,
    createdAt: '2026-10-27T01:00:00.000Z',
  };
  await writeFile(threadsFile(), `${JSON.stringify({
    version: 1,
    sessions: {
      's-old': { threads: [old], activeId: 't-old', pending: null },
    },
  }, null, 2)}\n`, 'utf8');
  const state = await getSession('s-old');
  assert.equal(state.threads.length, 1);
  assert.equal(state.threads[0].segments.length, 1);
  assert.equal(state.threads[0].segments[0].fromSeq, 10);
  assert.equal(state.threads[0].segments[0].toSeq, 20);
  assert.equal(state.threads[0].label, 'Old');
  const view = listView(state);
  assert.equal(view.length, 1);
  assert.equal(view[0].segments, 1);
  assert.match(view[0].display, /Old · 1 段 · 最近/);

  await updateSession('s-old', (current) => current);
  const raw = JSON.parse(await readFile(threadsFile(), 'utf8'));
  const saved = raw.sessions['s-old'].threads[0];
  assert.equal(saved.id, 't-old');
  assert.equal(saved.label, 'Old');
  assert.equal(saved.segments.length, 1);
  assert.equal(saved.segments[0].fromSeq, 10);
});

test('tool save rejects a missing next before touching state', async () => {
  const tool = createThreadsTool({
    sessionQuery: { readSession: async () => ({ events: [] }) },
    getBackend: () => ({ prepareSave: async () => { throw new Error('should not prepare'); } }),
  });
  await assert.rejects(
    () => tool.execute({ action: 'save', label: 'L', why: 'W' }, { agent: { session: { id: 's' } } }),
    /next is required/,
  );
});

test('safe mode registers recall and peer but not continuity/T tool', () => {
  const registered = [];
  const ctx = {
    sessionQuery: { readSession: async () => ({ events: [] }) },
    tokenMeter: {},
    tools: { register: (tool) => { registered.push(tool); return () => {}; } },
    effect: (fn) => fn(),
  };
  applyThreadsTool(ctx, { safeMode: true });
  assert.deepEqual(registered.map((entry) => entry.name), ['recall', 'peer_message']);
});

test('tool registers as continuity and active/list are callable', async () => {
  const registered = [];
  const ctx = {
    sessionQuery: { readSession: async () => ({ events: [] }) },
    tokenMeter: {},
    tools: { register: (tool) => { registered.push(tool); return () => {}; } },
    effect: (fn) => fn(),
  };
  applyThreadsTool(ctx);
  assert.equal(registered.length, 3);
  assert.deepEqual(registered.map((entry) => entry.name), ['continuity', 'recall', 'peer_message']);
  const tool = createThreadsTool({ sessionQuery: ctx.sessionQuery, tokenMeter: ctx.tokenMeter });
  const active = JSON.parse(await tool.execute({ action: 'active' }, { agent: { session: { id: 's-empty' } } }));
  const list = JSON.parse(await tool.execute({ action: 'list' }, { agent: { session: { id: 's-empty' } } }));
  assert.equal(active, null);
  assert.deepEqual(list, []);
});

test('load switches A→B→A active pointers', async () => {
  const session = { id: 's-switch', append: () => { throw new Error('load must defer append'); } };
  await updateSession('s-switch', (current) => {
    current.threads = [
      { id: 'a', label: 'A', why: 'w', next: 'n', seqStart: 1, seqEnd: 1, seqs: [1], spanStart: 'x', spanEnd: 'y', minutes: 1, tokens: 2, archiveRef: 'log:s-switch#seq=1-1' },
      { id: 'b', label: 'B', why: 'w', next: 'n', seqStart: 2, seqEnd: 2, seqs: [2], spanStart: 'x', spanEnd: 'y', minutes: 1, tokens: 2, archiveRef: 'log:s-switch#seq=2-2' },
    ];
    return current;
  });
  const core = new ThreadsCore({
    agent: { session },
    sessionQuery: {
      readSession: async () => ({
        events: [event(1, 'user/message', 'one'), event(2, 'user/message', 'two')],
      }),
    },
    backend: null,
  });
  assert.equal((await core.load({ id: 'a' })).active, true);
  assert.equal((await core.active()).id, 'a');
  assert.equal((await core.load({ id: 'b' })).active, true);
  assert.equal((await core.active()).id, 'b');
  assert.equal((await core.load({ id: 'a' })).active, true);
  assert.equal((await core.active()).id, 'a');
  const state = await getSession('s-switch');
  assert.equal(state.activeId, 'a');
  assert.equal(state.pending.kind, 'load');
  assert.equal(state.pending.id, 'a');
});

test('tag-debt：欠账不再锁工具（2026-10-30 改成回合末催补标）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tagdebt-'));
  const dir = join(root, '.dsh', 'continuity');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'tag-debt.json'), JSON.stringify({ count: 2, turns: [7, 8] }), 'utf8');
  const savedProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = root;
  try {
    const thread = {
      id: 't-debt', label: 'T', why: 'W', next: 'N', spanStart: 'x', spanEnd: 'y',
      minutes: 1, tokens: 10, seqStart: 1, seqEnd: 2, seqs: [1, 2], count: 2,
      archiveRef: 'log:s-debt#seq=1-2', sessionId: 's-debt',
      segments: [{
        fromSeq: 1, toSeq: 2, seqs: [1, 2], count: 2, spanStart: 'x', spanEnd: 'y',
        minutes: 1, tokens: 10, why: 'W', next: 'N', at: '2026-10-27T01:00:00.000Z',
        archiveRef: 'log:s-debt#seq=1-2',
      }],
    };
    const tool = createThreadsTool({
      sessionQuery: { readSession: async () => ({ events: [] }) },
      getBackend: () => ({ prepareSave: async () => ({ thread }) }),
    });
    // 有欠账也必须能继续干活：挡存会让实例最后存不下、消失。
    const result = JSON.parse(await tool.execute(
      { action: 'save', label: 'A', why: 'B', next: 'C' },
      { agent: { session: { id: 's-debt', append: () => ({}) } } },
    ));
    assert.notEqual(result.ok, false, '欠账不应再把 save 挡死');
  } finally {
    process.env.USERPROFILE = savedProfile;
    await rm(root, { recursive: true, force: true });
  }
});
