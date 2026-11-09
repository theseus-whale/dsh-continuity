import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emptyTags,
  findTagSeqs,
  findT0Ranges,
  normalizeTags,
  renderTagsMd,
  resolveTag,
  retagTags,
  tagCoverageForRange,
  tagRunStartAt,
  tagSeqs,
  tagsView,
  TAG_ZERO,
} from '../src/tags.mjs';
import { getSession, updateSession } from '../src/threads-store.mjs';
import { readTags, tagsFile, tagsMdFile, updateTags } from '../src/tags-store.mjs';
import { recordFold } from '../src/folds-store.mjs';
import { deletedDir } from '../src/deleted-store.mjs';
import { gistHeader } from '../src/provenance.mjs';
import { scanEvents } from '../src/threads.mjs';
import { estimateTextTokens } from '../src/threads.mjs';
import { threadGistText } from '../src/threads.mjs';
import { dominanceStartSeq } from '../src/threads.mjs';
import { ThreadsCore } from '../src/threads-core.mjs';
import { createThreadsTool } from '../src/threads-tool.mjs';

const home = await mkdtemp(join(tmpdir(), 'dsh-tags-'));
process.env.DSH_CONTINUITY_HOME = home;
after(async () => {
  await rm(home, { recursive: true, force: true });
});

function event(seq, type = 'user/message', text = `message ${seq}`, source = { kind: 'user' }) {
  return {
    seq,
    type,
    time: 1_700_000_000_000 + seq * 60_000,
    data: type === 'assistant/message'
      ? { message: { content: [{ type: 'text', text }] } }
      : { content: [{ type: 'text', text }], source },
  };
}

function coreFor(events, id = 's-tags') {
  return new ThreadsCore({
    agent: { session: { id } },
    sessionQuery: { readSession: async () => ({ events }) },
    backend: null,
  });
}

test('resolve: overrides win, later runs win, fallback is T0', () => {
  const tags = normalizeTags({
    version: 1,
    tags: { T0: { label: '未分类' }, T1: { label: 'one' }, T2: { label: 'two' } },
    runs: [[1, 5, 'T1'], [3, 7, 'T2']],
    overrides: { 4: 'T0', 8: 'T2' },
  });
  assert.equal(resolveTag(tags, 2), 'T1');
  assert.equal(resolveTag(tags, 4), 'T0');
  assert.equal(resolveTag(tags, 6), 'T2');
  assert.equal(resolveTag(tags, 8), 'T2');
  assert.equal(resolveTag(tags, 99), TAG_ZERO);
  assert.doesNotThrow(() => normalizeTags({ runs: [null, ['x', 2, 'T1']], overrides: { bad: 'T2' } }));
});

test('readTags: missing and corrupt fall back to T0 instead of throwing', async () => {
  const missing = await readTags();
  assert.equal(missing.missing, true);
  assert.equal(missing.corrupt, false);
  assert.equal(resolveTag(missing.state, 42), TAG_ZERO);

  await writeFile(tagsFile(), '{not json', 'utf8');
  const corrupt = await readTags();
  assert.equal(corrupt.corrupt, true);
  assert.equal(resolveTag(corrupt.state, 42), TAG_ZERO);

  await updateTags((tags) => {
    tags.tags.T2 = { label: 'Avatar' };
    tags.runs.push([1, 12, 'T2']);
    return tags;
  });
  const recovered = await readTags();
  assert.equal(recovered.corrupt, false);
  assert.equal(resolveTag(recovered.state, 5), 'T2');
});

test('find returns message seqs, filters, and span; empty tags are count 0', () => {
  const tags = normalizeTags({
    tags: { T0: { label: '未分类' }, T2: { label: 'Avatar' } },
    runs: [[1, 5, 'T2']],
    overrides: { 7: 'T2' },
  });
  const events = [
    event(1, 'user/message', 'one'),
    event(2, 'assistant/message', 'two'),
    event(3, 'user/message', 'three'),
    event(4, 'user/message', 'four'),
    event(5, 'assistant/message', 'five'),
    event(7, 'user/message', 'seven'),
    event(8, 'user/message', 'eight'),
  ];
  const found = findTagSeqs({ tags, id: 'T2', events });
  assert.deepEqual(found.seqs, [1, 2, 3, 4, 5, 7]);
  assert.equal(found.count, 6);
  assert.equal(found.first, 1);
  assert.equal(found.last, 7);
  assert.ok(JSON.stringify(found).length < 800);
  assert.ok((JSON.stringify(found).length / 4) < 200);
  assert.deepEqual(found.span, {
    start: new Date(1_700_000_000_000 + 60_000).toISOString(),
    end: new Date(1_700_000_000_000 + 7 * 60_000).toISOString(),
  });
  assert.deepEqual(findTagSeqs({ tags, id: 'T2', events, after: 4 }).seqs, [5, 7]);
  assert.deepEqual(findTagSeqs({ tags, id: 'T2', events, before: 3 }).seqs, [1, 2]);
  assert.deepEqual(findTagSeqs({ tags, id: 'T2', events, limit: 2 }).seqs, [1, 2]);
  const empty = findTagSeqs({ tags, id: 'T9', events });
  assert.equal(empty.count, 0);
  assert.deepEqual(empty.seqs, []);
  assert.equal(empty.span, null);
  assert.equal(findTagSeqs({ tags: emptyTags(), id: 'T0', events: [event(9, 'user/message', 'nine')] }).count, 1);
});

test('T0 find is the complement of non-T0 coverage', () => {
  const events = Array.from({ length: 10 }, (_, index) => event(900 + index, 'user/message', `m${index}`));
  events.push(...Array.from({ length: 6 }, (_, index) => event(1395 + index, 'assistant/message', `n${index}`)));
  const t0 = findT0Ranges({
    tags: normalizeTags({ runs: [[958, 1330, 'T2']] }),
    events,
    limit: 20,
  });
  assert.equal(t0.complement, true);
  assert.equal(t0.seqs.length, 0);
  assert.ok(t0.ranges.some(([start, end]) => start === 0 && end === 957));
  assert.ok(t0.ranges.some(([start, end]) => start === 1331 && end === 1400));
  assert.ok(!t0.ranges.some(([start, end]) => start >= 958 && end <= 1330));
  assert.ok(JSON.stringify(t0).length < 800);
  const all = findT0Ranges({ tags: emptyTags(), events: [event(0), event(1), event(2)] });
  assert.deepEqual(all.ranges, [[0, 2]]);
  assert.equal(all.count, 3);
});

test('find after/before are strict, limit is stable and ascending', () => {
  const events = Array.from({ length: 10 }, (_, index) => event(index + 1, index % 2 === 0 ? 'user/message' : 'assistant/message', `m${index + 1}`));
  const tags = normalizeTags({ runs: [[1, 10, 'T2']] });
  assert.deepEqual(findTagSeqs({ tags, id: 'T2', events, after: 5 }).seqs, [6, 7, 8, 9, 10]);
  assert.deepEqual(findTagSeqs({ tags, id: 'T2', events, before: 5 }).seqs, [1, 2, 3, 4]);
  assert.deepEqual(findTagSeqs({ tags, id: 'T2', events, limit: 3 }).seqs, [1, 2, 3]);
  assert.deepEqual(findTagSeqs({ tags, id: 'T2', events, after: 2, limit: 2 }).seqs, [3, 4]);
  assert.equal(findTagSeqs({ tags, id: 'T2', events, after: 10 }).count, 0);
});

test('tags view uses label or short display, count, and active', () => {
  const labeled = tagSeqs(emptyTags(), { seqs: [1, 2], id: 'T2', label: '头像' }).state;
  const view = tagsView(labeled, { activeId: 'T3' });
  const row = view.tags.find((entry) => entry.id === 'T2');
  assert.equal(row.label, '头像');
  assert.equal(row.display, '头像');
  assert.equal(row.count, 2);
  assert.equal(row.entries, 2);
  assert.equal(row.events, 2);
  assert.equal(row.overrides, 2);
  const long = tagSeqs(emptyTags(), { seqs: [1], id: 't-abcdef1234567890' }).state;
  const short = tagsView(long).tags.find((entry) => entry.id === 't-abcdef1234567890');
  assert.equal(short.display, 't-abcdef');
  assert.equal(short.label, undefined);
  const active = tagsView(labeled, { activeId: 'T2' }).tags.find((entry) => entry.id === 'T2');
  assert.equal(active.active, true);
  assert.ok(typeof view.updatedAt === 'string');
});

test('tag and retag immediately move the index', () => {
  const first = tagSeqs(emptyTags(), { seqs: [10, 11], id: 'T5' });
  assert.equal(first.count, 2);
  const found = findTagSeqs({ tags: first.state, id: 'T5', seqs: [10, 11, 12] });
  assert.deepEqual(found.seqs, [10, 11]);
  const moved = retagTags(first.state, { from: 'T5', to: 'T6' });
  assert.equal(moved.moved, 2);
  assert.equal(findTagSeqs({ tags: moved.state, id: 'T5', seqs: [10, 11, 12] }).count, 0);
  assert.deepEqual(findTagSeqs({ tags: moved.state, id: 'T6', seqs: [10, 11, 12] }).seqs, [10, 11]);
  const view = tagsView(moved.state);
  assert.equal(view.tags.find((row) => row.id === 'T6').overrides, 2);
  assert.equal(view.tags.some((row) => row.id === 'T5'), false);
});

test('tag range writes one run; overrides stay ahead; retag and untag work', async () => {
  await rm(tagsFile(), { force: true });
  const events = Array.from({ length: 220 }, (_, index) => event(index + 1, index % 2 === 0 ? 'user/message' : 'assistant/message', `m${index + 1}`));
  const core = coreFor(events, 's-tag-range');

  const range = await core.tag({ fromSeq: 100, toSeq: 200, id: 'T1', label: 'Range' });
  assert.equal(range.ok, true);
  assert.deepEqual(range.range, [100, 200]);
  assert.equal(range.count, 101);
  let index = await core.tags();
  let row = index.tags.find((entry) => entry.id === 'T1');
  assert.equal(row.runs, 1);
  assert.equal(row.overrides, 0);
  assert.equal(row.entries, 1);
  assert.equal(row.count, 101);
  assert.equal(row.events, 101);
  assert.equal(row.display, 'Range');
  let found = await core.find({ id: 'T1', limit: 100 });
  assert.deepEqual(found.seqs, Array.from({ length: 100 }, (_, offset) => 100 + offset));
  assert.deepEqual(found.ranges, [[100, 200]]);
  assert.equal(found.covered, 101);

  await core.tag({ seqs: [150], id: 'T2', label: 'Pin' });
  found = await core.find({ id: 'T1', limit: 5 });
  assert.deepEqual(found.ranges, [[100, 149], [151, 200]]);
  assert.equal(found.covered, 100);
  assert.equal((await core.find({ id: 'T2' })).seqs[0], 150);
  assert.ok(!found.seqs.includes(150));
  const t0Before = await core.find({ id: 'T0' });
  assert.ok(t0Before.ranges.every(([start, end]) => end < 100 || start > 200));

  const moved = await core.retag({ from: 'T1', to: 'T3' });
  assert.equal(moved.ok, true);
  assert.equal((await core.find({ id: 'T1' })).covered, 0);
  assert.deepEqual((await core.find({ id: 'T3', limit: 20 })).ranges, [[100, 149], [151, 200]]);

  const cleared = await core.untag({ fromSeq: 100, toSeq: 200 });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.removedOverrides, 1);
  assert.equal((await core.find({ id: 'T3' })).covered, 0);
  assert.equal((await core.find({ id: 'T2' })).count, 0);
  const t0 = await core.find({ id: 'T0' });
  assert.ok(t0.ranges.some(([start, end]) => start <= 100 && end >= 200));

  await rm(tagsFile(), { force: true });
  await core.tag({ fromSeq: 100, toSeq: 150, id: 'T8' });
  await core.tag({ fromSeq: 151, toSeq: 200, id: 'T8' });
  index = await core.tags();
  assert.equal(index.tags.find((entry) => entry.id === 'T8').runs, 2);
});

test('tool tag accepts a range and untag clears it', async () => {
  await rm(tagsFile(), { force: true });
  const events = Array.from({ length: 20 }, (_, index) => event(index + 1, 'user/message', `m${index + 1}`));
  const tool = createThreadsTool({ sessionQuery: { readSession: async () => ({ events }) } });
  const agent = { session: { id: 's-tool-range' } };
  const tagged = JSON.parse(await tool.execute({ action: 'tag', fromSeq: 2, toSeq: 10, id: 'T6' }, { agent }));
  assert.deepEqual(tagged.range, [2, 10]);
  assert.equal(tagged.count, 9);
  const found = JSON.parse(await tool.execute({ action: 'find', id: 'T6', limit: 20 }, { agent }));
  assert.equal(found.covered, 9);
  const cleared = JSON.parse(await tool.execute({ action: 'untag', fromSeq: 2, toSeq: 10 }, { agent }));
  assert.equal(cleared.ok, true);
  assert.equal(JSON.parse(await tool.execute({ action: 'find', id: 'T6' }, { agent })).covered, 0);
});

test('gist header carries T coverage', () => {
  const tags = emptyTags();
  tags.tags.T2 = { label: 'T2' };
  tags.tags.T3 = { label: 'T3' };
  tags.runs.push([1, 5, 'T2'], [6, 10, 'T3']);
  assert.equal(tagCoverageForRange(tags, 6, 10).label, 'T3');
  assert.equal(tagCoverageForRange(tags, 1, 10).label, 'T2 +5');
  assert.equal(tagCoverageForRange(tags, 11, 12).label, 'T0');
  const segment = {
    fromSeq: 6,
    toSeq: 10,
    count: 5,
    why: 'w',
    next: 'n',
    archiveRef: 'log:s#seq=6-10',
    tCoverage: 'T3',
    seqs: [6, 7, 8, 9, 10],
  };
  const thread = { id: 't-1', label: 'L', segments: [segment] };
  const gist = threadGistText(thread);
  assert.match(gist, /T=T3/);
  assert.ok(gist.indexOf('thread=') < gist.indexOf('T='));
  assert.match(threadGistText({ ...thread, segments: [{ ...segment, tCoverage: 'T2,T3' }] }), /T=T2,T3/);
  assert.match(gistHeader({ sessionId: 's', startSeq: 1, endSeq: 10, t: 'T2,T3' }), /T=T2,T3/);

  const aliasTags = emptyTags();
  aliasTags.runs.push([1, 10, 't-long']);
  const threads = [{ id: 't-long', alias: 'T3', label: 'Coo' }];
  assert.equal(tagCoverageForRange(aliasTags, 1, 10, { threads }).label, 'T3');
  const mixed = emptyTags();
  mixed.runs.push([1, 5, 'T2'], [6, 10, 'T0']);
  assert.equal(tagCoverageForRange(mixed, 1, 10).label, 'T2');
  assert.equal(tagCoverageForRange(emptyTags(), 1, 10).label, 'T0');
  const four = emptyTags();
  four.runs.push([1, 10, 'T1'], [11, 20, 'T2'], [21, 30, 'T3'], [31, 40, 'T4']);
  assert.equal(tagCoverageForRange(four, 1, 40).label, 'T1 +30');
  assert.equal(tagRunStartAt(four, 25), 21);
  assert.equal(tagRunStartAt(four, 100), null);
});

test('alias is the preferred display and keeps the active flag', () => {
  const tags = emptyTags();
  tags.tags.T3 = { label: 'Coo 线头' };
  tags.runs.push([1, 10, 'T3']);
  const threads = [{ id: 't-long-thread-id', alias: 'T3', label: 'Coo 线头' }];
  const view = tagsView(tags, { activeId: 't-long-thread-id', threads });
  const row = view.tags.find((entry) => entry.id === 'T3');
  assert.equal(row.display, 'T3');
  assert.equal(row.threadId, 't-long-thread-id');
  assert.equal(row.active, true);
  assert.equal(view.tags.some((entry) => entry.id === 't-long-thread-id'), false);
  const md = renderTagsMd(tags, { threads, activeId: 't-long-thread-id' });
  assert.match(md, /\| T3 \| Coo 线头 \|/);
});

test('alias resolves to the canonical thread: migrate, find, load, and count', async () => {
  await rm(tagsFile(), { force: true });
  await rm(tagsMdFile(), { force: true });
  await updateSession('s-alias-canonical', (current) => {
    current.threads = [{
      id: 't-long-thread',
      alias: 'T3',
      label: 'Coo 线头',
      segments: [{
        fromSeq: 1,
        toSeq: 10,
        seqs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        count: 10,
        why: 'w',
        next: 'n',
        archiveRef: 'log:s#seq=1-10',
      }],
    }];
    current.activeId = 't-long-thread';
    return current;
  });
  await updateTags((tags) => {
    tags.tags.T3 = { label: 'Coo 线头', alias: 'T3' };
    tags.runs.push([6, 10, 'T3']);
    return tags;
  });
  const events = Array.from({ length: 10 }, (_, index) => event(index + 1, 'user/message', `m${index + 1}`));
  const core = coreFor(events, 's-alias-canonical');

  const viaAlias = await core.find({ id: 'T3' });
  const viaCanonical = await core.find({ id: 't-long-thread' });
  assert.deepEqual(viaAlias.seqs, viaCanonical.seqs);
  assert.equal(viaAlias.count, viaCanonical.count);
  assert.equal(viaAlias.count, viaAlias.covered);
  assert.equal(viaAlias.count, 5);
  const page = await core.find({ id: 'T3', limit: 2 });
  assert.equal(page.count, viaAlias.count);
  assert.ok(page.seqs.length <= 2);

  const index = await core.tags();
  const rows = index.tags.filter((row) => row.id === 'T3');
  assert.equal(rows.length, 0);
  const canonical = index.tags.find((row) => row.id === 't-long-thread');
  assert.equal(canonical.alias, 'T3');
  assert.equal(canonical.display, 'T3');
  assert.equal(canonical.events, 5);
  const raw = await readTags();
  assert.equal(raw.state.tags.T3, undefined);
  assert.ok(raw.state.runs.every((run) => run[2] === 't-long-thread'));

  const aliasTag = await core.tag({ id: 'T3', label: 'Coo 线头' });
  assert.equal(aliasTag.id, 't-long-thread');
  assert.equal(aliasTag.display, 'T3');
  assert.equal((await readTags()).state.tags.T3, undefined);

  const loaded = await core.load({ id: 'T3' });
  assert.equal(loaded.mode, 'thread');
  assert.equal(loaded.id, 't-long-thread');
  const t0 = await core.find({ id: 'T0' });
  assert.equal(t0.count, t0.covered);
  const retagged = await core.retag({ from: 'T3', to: 't-long-thread' });
  assert.equal(retagged.ok, true);
  assert.equal((await readTags()).state.tags.T3, undefined);
  const unknownRetag = await core.retag({ from: 'NOPE', to: 't-long-thread' });
  assert.equal(unknownRetag.ok, false);
  assert.equal(unknownRetag.reason, 'unknown-tag-id');
});

test('dominance block crosses small islands but stops at a real T', () => {
  const tags = emptyTags();
  tags.runs.push([1, 20, 'T2'], [21, 25, 'T3'], [26, 30, 'T2'], [31, 35, 'T3']);
  assert.equal(dominanceStartSeq(tags, 33), 21);
  assert.equal(dominanceStartSeq(tags, 23), 21);
  tags.runs = [[1, 20, 'T2'], [21, 30, 'T2'], [31, 35, 'T3']];
  assert.equal(dominanceStartSeq(tags, 33), 31);
  assert.equal(dominanceStartSeq(tags, 99), null);
});

test('tags.md is regenerated from tags.json and overwrites hand edits', async () => {
  await rm(tagsFile(), { force: true });
  await rm(tagsMdFile(), { force: true });
  const events = [1, 2, 3].map((seq) => event(seq, 'user/message', `m${seq}`));
  const core = coreFor(events, 's-tags-md');
  const tagged = await core.tag({ seqs: [1], id: 'T9', label: '测试', keywords: ['a', 'b'] });
  assert.deepEqual(tagged.keywords, ['a', 'b']);
  let md = await readFile(tagsMdFile(), 'utf8');
  assert.match(md, /\| T9 \| 测试 \| a, b \|/);
  await writeFile(tagsMdFile(), 'HAND EDIT\n', 'utf8');
  await core.tag({ seqs: [2], id: 'T9', label: '测试2' });
  md = await readFile(tagsMdFile(), 'utf8');
  assert.doesNotMatch(md, /HAND EDIT/);
  assert.match(md, /测试2/);
  await core.retag({ from: 'T9', to: 'T10' });
  md = await readFile(tagsMdFile(), 'utf8');
  assert.match(md, /\| T10 \|/);
});

test('find splits visible/folded and load marks folded seqs; first/last select ends', async () => {
  await rm(tagsFile(), { force: true });
  const events = Array.from({ length: 12 }, (_, index) => event(index + 1, 'user/message', `m${index + 1}`));
  const core = coreFor(events, 's-fold');
  await core.tag({ fromSeq: 1, toSeq: 10, id: 'T1' });
  await recordFold('s-fold', { from: 3, to: 4, gistSeq: 99 });
  const found = await core.find({ id: 'T1' });
  assert.deepEqual(found.folded, [3, 4]);
  assert.equal(found.count, 10);
  assert.equal(found.covered, 10);
  const page = await core.find({ id: 'T1', limit: 2 });
  assert.equal(page.count, found.count);
  assert.ok(page.seqs.length <= 2);
  assert.ok(found.visible.includes(1));
  assert.ok(found.visible.includes(10));
  assert.ok(!found.visible.includes(3));
  const all = await core.load({ id: 'T1', first: 10, last: 0 });
  assert.equal(all.segs.length, 10);
  const pending = await getSession('s-fold');
  assert.match(pending.pending.text, /\[已折叠于 gist seq=99\]/);
  const latest = await core.load({ id: 'T1', first: 0, last: 2 });
  assert.deepEqual(latest.segs, [9, 10]);
  const oldest = await core.load({ id: 'T1', first: 2, last: 0 });
  assert.deepEqual(oldest.segs, [1, 2]);
  const defaults = await core.load({ id: 'T1' });
  assert.deepEqual(defaults.segs, [1, 2, 3, 6, 7, 8, 9, 10]);
});

test('tag metadata-only updates label/keywords/alias without seq ownership', async () => {
  await rm(tagsFile(), { force: true });
  await rm(tagsMdFile(), { force: true });
  await updateSession('s-meta', (current) => {
    current.threads = [{ id: 't-long-thread', label: 'Coo 线头', active: true }];
    current.activeId = 't-long-thread';
    return current;
  });
  const events = [1, 2, 3].map((seq) => event(seq, 'user/message', `m${seq}`));
  const core = coreFor(events, 's-meta');
  const meta = await core.tag({
    id: 't-long-thread',
    label: 'Coo 线头',
    keywords: ['头像', '呆毛'],
    alias: 'T3',
  });
  assert.equal(meta.ok, true);
  assert.equal(meta.alias, 'T3');
  assert.equal(meta.display, 'T3');
  assert.equal(meta.active, true);
  const session = await getSession('s-meta');
  assert.equal(session.threads[0].alias, 'T3');
  const tags = await readTags();
  assert.equal(tags.state.tags['t-long-thread'].alias, 'T3');
  assert.deepEqual(tags.state.tags['t-long-thread'].keywords, ['头像', '呆毛']);
  assert.equal(tags.state.runs.length, 0);
  assert.deepEqual(tags.state.overrides, {});

  await updateTags((current) => {
    current.tags.T2 = { label: 'T2' };
    return current;
  });
  const labelOnly = await core.tag({ id: 'T2', label: 'Coo 的形象' });
  assert.equal(labelOnly.display, 'Coo 的形象');
  assert.equal(labelOnly.entries, 0);
  const keywordsOnly = await core.tag({ id: 'T2', keywords: ['笑脸'] });
  assert.deepEqual(keywordsOnly.keywords, ['笑脸']);
  assert.equal(keywordsOnly.events, 0);
  await assert.rejects(() => core.tag({ id: 'T2' }), /metadata field|seqs, fromSeq/);
  const unknown = await core.tag({ id: 'T-UNKNOWN', label: 'x' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'unknown-tag-id');

  const index = await core.tags();
  const aliasRow = index.tags.find((row) => row.id === 't-long-thread');
  assert.equal(aliasRow.alias, 'T3');
  assert.equal(aliasRow.display, 'T3');
  assert.equal(aliasRow.active, true);
  const md = await readFile(tagsMdFile(), 'utf8');
  assert.doesNotMatch(md, /\| T3 \|/);

  const tool = createThreadsTool({ sessionQuery: { readSession: async () => ({ events }) } });
  const viaTool = JSON.parse(await tool.execute(
    { action: 'tag', id: 'T2', label: 'via tool', alias: 'T4' },
    { agent: { session: { id: 's-meta' } } },
  ));
  assert.equal(viaTool.ok, true);
  assert.equal(viaTool.label, 'via tool');
  assert.equal(viaTool.alias, 'T4');
  assert.equal(viaTool.display, 'T4');
});

test('T0 tags() events equals find(T0).count before/after a fold', async () => {
  await rm(tagsFile(), { force: true });
  const events = Array.from({ length: 10 }, (_, index) => event(index + 1, 'user/message', `m${index + 1}`));
  const core = coreFor(events, 's-t0-count');
  await core.tag({ fromSeq: 3, toSeq: 5, id: 'T2', label: 'T2' });
  const beforeTags = await core.tags();
  const beforeT0 = beforeTags.tags.find((row) => row.id === 'T0');
  const beforeFind = await core.find({ id: 'T0' });
  assert.equal(beforeT0.events, beforeFind.count);
  const beforeT2 = beforeTags.tags.find((row) => row.id === 'T2');
  const beforeFindT2 = await core.find({ id: 'T2' });
  assert.equal(beforeT2.events, beforeFindT2.covered);
  assert.equal(beforeT2.events, beforeFindT2.count);
  const md = await readFile(tagsMdFile(), 'utf8');
  const t0Line = md.split('\n').find((line) => line.startsWith('| T0 '));
  assert.ok(t0Line.includes(`| ${beforeT0.events} |`));

  await recordFold('s-t0-count', { from: 3, to: 4, gistSeq: 99 });
  const afterTags = await core.tags();
  const afterT0 = afterTags.tags.find((row) => row.id === 'T0');
  const afterFind = await core.find({ id: 'T0' });
  assert.equal(afterT0.events, beforeT0.events);
  assert.equal(afterFind.count, beforeFind.count);
  assert.equal(afterT0.events, afterFind.count);
});

test('delete empty thread backs it up and removes the tag row', async () => {
  await rm(tagsFile(), { force: true });
  await rm(tagsMdFile(), { force: true });
  await rm(deletedDir(), { recursive: true, force: true });
  await updateSession('s-delete', (current) => {
    current.threads = [
      { id: 't-empty', label: 'empty', segments: [], active: false },
      {
        id: 't-full',
        label: 'full',
        active: false,
        segments: [{
          fromSeq: 1,
          toSeq: 1,
          seqs: [1],
          count: 1,
          tokens: 10,
          why: 'w',
          next: 'n',
          archiveRef: 'log:s#seq=1-1',
        }],
      },
    ];
    current.activeId = null;
    return current;
  });
  await updateTags((tags) => {
    tags.tags['t-empty'] = { label: 'empty' };
    return tags;
  });
  const core = coreFor([event(1, 'user/message', 'm1')], 's-delete');
  const deleted = await core.delete({ id: 't-empty' });
  assert.equal(deleted.ok, true);
  assert.ok(deleted.backup.startsWith(deletedDir()));
  const backup = JSON.parse(await readFile(deleted.backup, 'utf8'));
  assert.equal(backup.id, 't-empty');
  assert.ok(backup.thread);
  const list = await core.list();
  assert.equal(list.some((thread) => thread.id === 't-empty'), false);
  assert.equal((await readTags()).state.tags['t-empty'], undefined);
  const md = await readFile(tagsMdFile(), 'utf8');
  assert.doesNotMatch(md, /t-empty/);

  const refused = await core.delete({ id: 't-full' });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'not-empty');
  const forced = await core.delete({ id: 't-full', force: true });
  assert.equal(forced.ok, true);
  assert.equal((await core.list()).length, 0);
});

test('Core find(T0) returns the complement; after/limit are strict and stable', async () => {
  await rm(tagsFile(), { force: true });
  const events = [1, 2, 3, 4, 5].map((seq) => event(seq, 'user/message', `m${seq}`));
  await updateTags((tags) => {
    tags.tags.T2 = { label: 'two' };
    tags.runs.push([2, 4, 'T2']);
    return tags;
  });
  const core = coreFor(events, 's-find2');
  const t0 = await core.find({ id: 'T0' });
  assert.equal(t0.complement, true);
  assert.deepEqual(t0.ranges, [[0, 1], [5, 5]]);
  assert.equal(t0.count, 3);
  const t2 = await core.find({ id: 'T2', after: 2, limit: 1 });
  assert.deepEqual(t2.seqs, [3]);
  assert.equal((await core.find({ id: 'T9' })).count, 0);
  const before = (await core.tags()).updatedAt;
  await core.tag({ seqs: [5], id: 'T7', label: 'seven' });
  const after = await core.tags();
  assert.ok(after.updatedAt);
  assert.notEqual(after.updatedAt, before);
  const row = after.tags.find((entry) => entry.id === 'T7');
  assert.equal(row.display, 'seven');
  assert.equal(row.label, 'seven');
});

test('Core find/tag/retag/tags share the sidecar and write nothing else', async () => {
  const events = [event(1, 'user/message', 'one'), event(2, 'assistant/message', 'two')];
  const core = coreFor(events, 's-core-tags');
  await core.tag({ seqs: [2], id: 'T3' });
  const found = await core.find({ id: 'T3' });
  assert.deepEqual(found.seqs, [2]);
  const view = await core.tags();
  assert.ok(view.tags.some((row) => row.id === 'T3' && row.overrides === 1));
  await core.retag({ from: 'T3', to: 'T4' });
  assert.equal((await core.find({ id: 'T3' })).count, 0);
  assert.deepEqual((await core.find({ id: 'T4' })).seqs, [2]);
});

test('tool exposes find/tag/retag/tags actions', async () => {
  const events = [event(1, 'user/message', 'one'), event(2, 'assistant/message', 'two')];
  const tool = createThreadsTool({
    sessionQuery: { readSession: async () => ({ events }) },
  });
  const agent = { session: { id: 's-tool-tags' } };
  const tag = JSON.parse(await tool.execute({ action: 'tag', seqs: [2], id: 'T8' }, { agent }));
  assert.equal(tag.ok, true);
  assert.deepEqual(JSON.parse(await tool.execute({ action: 'find', id: 'T8' }, { agent })).seqs, [2]);
  assert.deepEqual(JSON.parse(await tool.execute({ action: 'find', id: 'T8', after: 1, limit: 1 }, { agent })).seqs, [2]);
  const t0 = JSON.parse(await tool.execute({ action: 'find', id: 'T0' }, { agent }));
  assert.equal(t0.complement, true);
  assert.ok(t0.ranges.some(([start, end]) => start <= 1 && end >= 1));
  const index = JSON.parse(await tool.execute({ action: 'tags' }, { agent }));
  assert.ok(index.tags.some((row) => row.id === 'T8'));
  const moved = JSON.parse(await tool.execute({ action: 'retag', from: 'T8', to: 'T9' }, { agent }));
  assert.equal(moved.ok, true);
  assert.equal(JSON.parse(await tool.execute({ action: 'find', id: 'T8' }, { agent })).count, 0);
  assert.deepEqual(JSON.parse(await tool.execute({ action: 'find', id: 'T9' }, { agent })).seqs, [2]);
});

test('scan seqs returns only those seqs and drops reasoning', () => {
  const events = [
    event(1, 'user/message', 'one'),
    event(2, 'assistant/message', 'two'),
    {
      seq: 3,
      type: 'assistant/message',
      data: { message: { content: [{ type: 'reasoning', text: 'r'.repeat(5000) }] } },
    },
    event(4, 'user/message', 'four'),
  ];
  const items = scanEvents({ events, seqs: [1, 4] });
  assert.deepEqual(items.map((item) => item.seq), [1, 4]);
  assert.ok(items.every((item) => !item.head.includes('[reasoning]')));
  assert.equal(items.every((item) => item.head.length <= 160), true);
});

test('scan of 50 turns stays under the 2k-token list target', () => {
  const events = Array.from({ length: 50 }, (_, index) => event(
    index + 1,
    index % 2 === 0 ? 'user/message' : 'assistant/message',
    `turn ${index + 1}: ` + 'some decision text '.repeat(8),
  ));
  const items = scanEvents({ events, fromSeq: 1, toSeq: 50 });
  assert.ok(items.length <= 20);
  assert.ok(items.every((item) => item.head.length <= 160));
  assert.ok(estimateTextTokens(JSON.stringify(items)) < 2000);
});

test('load withReasoning includes paired reasoning, truncates, and stops at 16k', async () => {
  await rm(tagsFile(), { force: true });
  const events = Array.from({ length: 8 }, (_, index) => {
    const seq = index + 1;
    return {
      seq,
      type: 'assistant/message',
      time: 1_700_000_000_000 + seq * 60_000,
      data: {
        message: {
          content: [
            { type: 'reasoning', text: `R${seq}:` + 'R'.repeat(4000) },
            { type: 'text', text: `B${seq}:` + 'B'.repeat(12000) },
          ],
        },
      },
    };
  });
  const core = coreFor(events, 's-reasoning');
  await core.tag({ seqs: [1, 2, 3, 4, 5, 6, 7, 8], id: 'T2' });
  const load = await core.load({ id: 'T2', withReasoning: true });
  assert.equal(load.ok, true);
  assert.equal(load.budget, 16000);
  assert.ok(load.tokens <= 16000);
  assert.ok(load.reasoningInjected > 0);
  assert.ok(load.reasoningTokens > 0);
  assert.ok(load.skipped > 0);
  const pending = await getSession('s-reasoning');
  assert.match(pending.pending.text, /\[reasoning · 截断\]/);
  assert.match(pending.pending.text, /含 reasoning/);
  assert.match(pending.pending.text, /skipped/);

  const without = await core.load({ id: 'T2' });
  assert.equal(without.reasoningInjected, undefined);
  const plain = await getSession('s-reasoning');
  assert.doesNotMatch(plain.pending.text, /\[reasoning/);
  assert.match(plain.pending.text, /已去 reasoning/);

  await updateSession('s-reasoning', (current) => {
    current.threads = [{
      id: 't-big',
      label: 'big',
      segments: [{
        fromSeq: 1,
        toSeq: 8,
        seqs: [1, 2, 3, 4, 5, 6, 7, 8],
        count: 8,
        why: 'w',
        next: 'n',
        archiveRef: 'log:s#seq=1-8',
      }],
    }];
    current.activeId = 't-big';
    return current;
  });
  const threadLoad = await core.load({ id: 't-big', withReasoning: true });
  assert.equal(threadLoad.ok, true);
  assert.equal(threadLoad.budget, 16000);
  assert.ok(threadLoad.tokens <= 16000);
  assert.ok(threadLoad.reasoningInjected > 0);
  assert.ok(threadLoad.skipped > 0);
  const threadPending = await getSession('s-reasoning');
  assert.match(threadPending.pending.text, /\[reasoning · 截断\]/);
  assert.match(threadPending.pending.text, /skipped/);

  const tool = createThreadsTool({ sessionQuery: { readSession: async () => ({ events }) } });
  const viaTool = JSON.parse(await tool.execute(
    { action: 'load', id: 'T2', withReasoning: true },
    { agent: { session: { id: 's-reasoning' } } },
  ));
  assert.equal(viaTool.budget, 16000);
  assert.ok(viaTool.reasoningInjected > 0);
  assert.ok(viaTool.skipped > 0);
});

test('withReasoning pairs a reasoning-only event in the same turn', async () => {
  await rm(tagsFile(), { force: true });
  const events = [
    event(1, 'user/message', 'question'),
    {
      seq: 2,
      type: 'assistant/message',
      time: 1_700_000_000_120,
      data: { message: { content: [{ type: 'reasoning', text: 'why this choice' }] } },
    },
    event(3, 'assistant/message', 'the answer'),
  ];
  const core = coreFor(events, 's-reasoning-pair');
  await core.tag({ seqs: [1, 2, 3], id: 'T2' });
  const load = await core.load({ id: 'T2', withReasoning: true });
  assert.equal(load.reasoningInjected, 1);
  const pending = await getSession('s-reasoning-pair');
  assert.match(pending.pending.text, /\[reasoning\]\nwhy this choice/);
  assert.doesNotMatch(pending.pending.text, /\[reasoning\][^\n]*question/);
});

test('load tag uses earliest 3 + latest 5, budget, segs, and no active change', async () => {
  await rm(tagsFile(), { force: true });
  const events = Array.from({ length: 10 }, (_, index) => event(index + 1, index % 2 === 0 ? 'user/message' : 'assistant/message', `m${index + 1}`));
  await updateTags((tags) => {
    tags.tags.T2 = { label: 'Avatar' };
    tags.runs.push([1, 10, 'T2']);
    return tags;
  });
  const core = coreFor(events, 's-load-tag');
  const result = await core.load({ id: 'T2', budgetTokens: 8_000 });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'tag');
  assert.equal(result.active, false);
  assert.deepEqual(result.segs, [1, 2, 3, 6, 7, 8, 9, 10]);
  assert.equal(result.injected, 8);
  const pendingText = (await getSession('s-load-tag')).pending.text;
  assert.match(pendingText, /^\[取\] Avatar/);
  assert.doesNotMatch(pendingText, /Avatar · Avatar/);
  const state = await core.tags();
  assert.ok(state.tags.some((row) => row.id === 'T2'));
  const tight = await core.load({ id: 'T2', budgetTokens: 1 });
  assert.ok(tight.tokens <= 1);
  assert.ok(tight.injected <= 1);
  await assert.rejects(
    () => core.load({ id: 'T2', select: [1] }),
    /only valid for a thread/,
  );
});

test('load seqs injects exactly those visible seqs and returns segs', async () => {
  const events = [
    event(2, 'user/message', 'two'),
    event(10, 'user/message', 'ten'),
    {
      seq: 11,
      type: 'assistant/message',
      data: { message: { content: [{ type: 'reasoning', text: 'secret' }] } },
    },
  ];
  const core = coreFor(events, 's-load-seqs');
  const result = await core.load({ seqs: [2, 10, 11] });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'seqs');
  assert.equal(result.active, false);
  assert.deepEqual(result.segs, [2, 10]);
  assert.equal(result.injected, 2);
  const raw = await core.load({ seqs: [99] });
  assert.equal(raw.ok, false);
  assert.equal(raw.reason, 'unknown-seq');
});

test('tags action warns on missing/corrupt state without failing', async () => {
  await rm(tagsFile(), { force: true });
  const core = coreFor([], 's-tags-warning');
  const view = await core.tags();
  assert.equal(view.warning, 'tags.json missing; using T0');
  assert.ok(Array.isArray(view.tags));
  await writeFile(tagsFile(), '{bad', 'utf8');
  const corrupt = await core.tags();
  assert.equal(corrupt.warning, 'tags.json corrupt; using T0');
});


test('多标签检索：同一 seq 搜 T1 和 T2 都能搜到', async () => {
  const { findTagSeqs } = await import('../src/tags.mjs');
  const tags = {
    tags: { T1: { label: 'A' }, T2: { label: 'B' } },
    runs: [[0, 10, 'T1']],
    overrides: {},
    memberships: { '5': ['T2'] },
  };
  const hit1 = findTagSeqs({ tags, id: 'T1', seqs: [1, 5, 9] });
  const hit2 = findTagSeqs({ tags, id: 'T2', seqs: [1, 5, 9] });
  if (!hit1.seqs.includes(5)) throw new Error('T1 应包含 5');
  if (!hit2.seqs.includes(5)) throw new Error('T2 应包含 5（附加成员）');
  if (hit2.seqs.includes(1)) throw new Error('T2 不该包含 1');
});
