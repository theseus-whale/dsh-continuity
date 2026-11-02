/**
 * Continuity tags — sidecar T labels over turn ranges.
 *
 * Pure index operations only: resolve, find, tag, retag, and a cheap list.
 * No session text is read here and no [TX] is ever written into the raw log.
 */
export const TAG_ZERO = 'T0';

/** T0 是桶，不是话题：它可以出现在索引里，但**永不参与匹配/候选**。 */
export function matchableTags(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) => String(row?.id ?? row?.alias ?? "") !== TAG_ZERO);
}
export const TAG_DEFAULT_LABEL = '未分类';
export const FIND_DEFAULT_LIMIT = 20;
export const FIND_MAX_LIMIT = 100;

function asInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function asId(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeEntry(id, value) {
  const entry = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const label = asId(entry.label) ?? (id === TAG_ZERO ? TAG_DEFAULT_LABEL : id);
  const status = entry.status === 'open' || entry.status === 'closed' ? entry.status : undefined;
  const lifecycle = ['provisional', 'active', 'merged', 'archived'].includes(entry.lifecycle)
    ? entry.lifecycle
    : undefined;
  const keywords = Array.isArray(entry.keywords)
    ? [...new Set(entry.keywords.map((item) => String(item).trim()).filter(Boolean))]
    : [];
  const alias = asId(entry.alias);
  const legacyAliases = Array.isArray(entry.legacyAliases)
    ? [...new Set(entry.legacyAliases.map((item) => String(item).trim()).filter(Boolean))]
    : [];
  const mergedFrom = Array.isArray(entry.mergedFrom)
    ? [...new Set(entry.mergedFrom.map(asId).filter((item) => item !== null))]
    : [];
  const mergedInto = asId(entry.mergedInto);
  const useCount = Number.isInteger(Number(entry.useCount)) ? Math.max(0, Number(entry.useCount)) : undefined;
  return {
    label,
    ...(alias === null ? {} : { alias }),
    ...(status === undefined ? {} : { status }),
    ...(lifecycle === undefined ? {} : { lifecycle }),
    ...(mergedInto === null ? {} : { mergedInto }),
    ...(legacyAliases.length === 0 ? {} : { legacyAliases }),
    ...(mergedFrom.length === 0 ? {} : { mergedFrom }),
    ...(useCount === undefined ? {} : { useCount }),
    ...(keywords.length === 0 ? {} : { keywords }),
  };
}

/** Follow mergedInto to the canonical tag id. Never follows cycles. */
export function canonicalTagId(tags, id) {
  const state = tags !== null && typeof tags === 'object' && tags.tags !== undefined ? tags : normalizeTags(tags);
  let current = asId(id);
  if (current === null || current === TAG_ZERO) return current;
  if (state.tags?.[current]?.lifecycle === 'archived') return null;
  const seen = new Set();
  while (current !== null && state.tags?.[current]?.mergedInto !== undefined) {
    if (seen.has(current)) return current;
    seen.add(current);
    const next = asId(state.tags[current].mergedInto);
    if (next === null || next === current) return current;
    current = next;
  }
  return current;
}

/** Resolve old id or legacy alias to a canonical tag id, or null. */
export function canonicalTagRef(tags, token) {
  const state = tags !== null && typeof tags === 'object' && tags.tags !== undefined ? tags : normalizeTags(tags);
  const key = asId(token);
  if (key === null) return null;
  if (state.tags?.[key] !== undefined) return canonicalTagId(state, key);
  const lower = key.toLowerCase();
  for (const [id, entry] of Object.entries(state.tags ?? {})) {
    if (entry?.lifecycle === 'archived') continue;
    if (String(entry?.alias ?? '').toLowerCase() === lower) return canonicalTagId(state, id);
    if (Array.isArray(entry?.legacyAliases)
      && entry.legacyAliases.some((alias) => String(alias).toLowerCase() === lower)) {
      return canonicalTagId(state, id);
    }
  }
  return null;
}
export function emptyTags() {
  return {
    version: 1,
    tags: { [TAG_ZERO]: { label: TAG_DEFAULT_LABEL } },
    runs: [],
    overrides: {},
    updatedAt: null,
    memberships: {}
  };
}

/** Read-compatible normalization; corrupt partial input never throws. */
export function normalizeTags(input) {
  const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const tags = {};
  const sourceTags = source.tags !== null && typeof source.tags === 'object' && !Array.isArray(source.tags)
    ? source.tags
    : {};
  for (const [key, value] of Object.entries(sourceTags)) {
    const id = asId(key);
    if (id !== null) tags[id] = normalizeEntry(id, value);
  }
  if (tags[TAG_ZERO] === undefined) tags[TAG_ZERO] = { label: TAG_DEFAULT_LABEL };

  const runs = [];
  for (const entry of Array.isArray(source.runs) ? source.runs : []) {
    const from = asInteger(Array.isArray(entry) ? entry[0] : entry?.from);
    const to = asInteger(Array.isArray(entry) ? entry[1] : entry?.to);
    const id = asId(Array.isArray(entry) ? entry[2] : entry?.id);
    if (from === null || to === null || id === null) continue;
    runs.push([Math.min(from, to), Math.max(from, to), id]);
  }

  // 多标签成员：seq -> [id...]。可选的附加层，旧数据没有这个键。
  const memberships = {};
  const sourceMemberships = source.memberships !== null && typeof source.memberships === 'object' && !Array.isArray(source.memberships)
    ? source.memberships
    : {};
  for (const [key, value] of Object.entries(sourceMemberships)) {
    const seq = asInteger(key);
    if (seq === null || !Array.isArray(value)) continue;
    const ids = value.map(asId).filter((id) => id !== null);
    if (ids.length > 0) memberships[String(seq)] = [...new Set(ids)];
  }

  const overrides = {};
  const sourceOverrides = source.overrides !== null && typeof source.overrides === 'object' && !Array.isArray(source.overrides)
    ? source.overrides
    : {};
  for (const [key, value] of Object.entries(sourceOverrides)) {
    const seq = asInteger(key);
    const id = asId(value);
    if (seq === null || id === null) continue;
    overrides[String(seq)] = id;
  }

  for (const id of new Set([...runs.map((run) => run[2]), ...Object.values(overrides)])) {
    if (tags[id] === undefined) tags[id] = normalizeEntry(id, {});
  }
  const updatedAt = typeof source.updatedAt === 'string' && source.updatedAt.length > 0
    ? source.updatedAt
    : null;
  return { version: 1, tags, runs, overrides, memberships, updatedAt };
}

/** Fast resolver over a normalized state; avoids re-normalizing per seq. */
export function tagResolver(tags) {
  const state = normalizeTags(tags);
  return (seq) => {
    const key = String(Number(seq));
    if (state.overrides[key] !== undefined) return canonicalTagId(state, state.overrides[key]) ?? TAG_ZERO;
    const number = Number(seq);
    for (let index = state.runs.length - 1; index >= 0; index -= 1) {
      const [from, to, id] = state.runs[index];
      if (number >= from && number <= to) return canonicalTagId(state, id) ?? TAG_ZERO;
    }
    return TAG_ZERO;
  };
}

/** Display labels for a folded range: alias → short label → short id; T0 only if all T0. */
export function tagCoverageForRange(tags, fromSeq, toSeq, { threads = [] } = {}) {
  const state = normalizeTags(tags);
  const from = Number(fromSeq);
  const to = Number(toSeq);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) {
    return { ids: [TAG_ZERO], label: TAG_ZERO, counts: {}, items: [] };
  }
  const counts = new Map();
  const resolve = tagResolver(state);
  for (let seq = from; seq <= to; seq += 1) {
    const id = resolve(seq);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const threadById = new Map();
  const aliasToThread = new Map();
  for (const thread of Array.isArray(threads) ? threads : []) {
    if (thread?.id === undefined || thread.id === null) continue;
    threadById.set(String(thread.id), thread);
    const alias = asId(thread.alias);
    if (alias !== null) aliasToThread.set(alias, thread);
  }
  const short = (value) => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text.length > 12 ? `${text.slice(0, 12)}…` : text;
  };
  const ids = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([id]) => id);
  const items = ids
    .filter((id) => id !== TAG_ZERO)
    .map((id) => {
      const thread = threadById.get(id) ?? aliasToThread.get(id) ?? null;
      const entry = state.tags[id];
      const alias = asId(entry?.alias) ?? asId(thread?.alias);
      const label = typeof entry?.label === 'string' && entry.label.length > 0 && entry.label !== id
        ? entry.label
        : typeof thread?.label === 'string' && thread.label.length > 0
          ? thread.label
          : null;
      const shortId = id.length > 8 ? `${id.slice(0, 8)}…` : id;
      return {
        id,
        count: counts.get(id) ?? 0,
        display: alias ?? (label === null ? shortId : short(label)),
      };
    });
  let label;
  if (items.length === 0) {
    label = TAG_ZERO;
  } else {
    const primary = items[0];
    const secondary = items.slice(1).reduce((sum, item) => sum + item.count, 0);
    label = `${primary.display}${secondary > 0 ? ` +${secondary}` : ''}`;
  }
  return {
    ids: ids.length > 0 ? ids : [TAG_ZERO],
    label,
    counts: Object.fromEntries(counts),
    items,
  };
}

/** Start of the latest tag run containing seq; null when seq is the implicit T0 tail. */
export function tagRunStartAt(tags, seq) {
  const state = normalizeTags(tags);
  const number = Number(seq);
  if (!Number.isInteger(number)) return null;
  for (let index = state.runs.length - 1; index >= 0; index -= 1) {
    const [from, to] = state.runs[index];
    if (number >= from && number <= to) return from;
  }
  return null;
}

/** overrides -> last containing run -> T0. */
export function resolveTag(tags, seq) {
  const state = normalizeTags(tags);
  const key = String(Number(seq));
  if (state.overrides[key] !== undefined) return canonicalTagId(state, state.overrides[key]) ?? TAG_ZERO;
  const number = Number(seq);
  for (let index = state.runs.length - 1; index >= 0; index -= 1) {
    const [from, to, id] = state.runs[index];
    if (number >= from && number <= to) return canonicalTagId(state, id) ?? TAG_ZERO;
  }
  return TAG_ZERO;
}

function messageSeqUniverse(events) {
  const list = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'user/message' && event?.type !== 'assistant/message') continue;
    const sourceKind = event?.data?.source?.kind;
    if (sourceKind === 'runtime-context' || sourceKind === 'compact-checkpoint') continue;
    const seq = asInteger(event.seq);
    if (seq !== null) list.push(seq);
  }
  return [...new Set(list)].sort((left, right) => left - right);
}

/**
 * Pure tag index. `seqs` is the message-seq universe (or pass `events`);
 * overrides for this id are included even when they are outside that universe.
 * Returns { seqs, count, first, last, span } with span from event times.
 */
export function findTagSeqs({
  tags,
  id,
  seqs = null,
  events = null,
  after = undefined,
  before = undefined,
  limit = FIND_DEFAULT_LIMIT,
} = {}) {
  const state = normalizeTags(tags);
  const tagId = asId(id);
  if (tagId === null) throw new Error('find: id is required');
  const universe = Array.isArray(seqs)
    ? [...new Set(seqs.map(asInteger).filter((seq) => seq !== null))].sort((left, right) => left - right)
    : messageSeqUniverse(events);
  const bySeq = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const seq = asInteger(event?.seq);
    if (seq !== null) bySeq.set(seq, event);
  }

  const found = new Set();
  for (const seq of universe) {
    // 主标签命中，或该 seq 显式登记为这个标签的附加成员
    if (resolveTag(state, seq) === tagId || (state.memberships?.[String(seq)] ?? []).includes(tagId)) found.add(seq);
  }
  for (const [key, value] of Object.entries(state.overrides)) {
    if (value === tagId) found.add(Number(key));
  }

  let list = [...found].sort((left, right) => left - right);
  if (after !== undefined && after !== null) list = list.filter((seq) => seq > Number(after));
  if (before !== undefined && before !== null) list = list.filter((seq) => seq < Number(before));
  const max = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.min(FIND_MAX_LIMIT, Math.trunc(Number(limit)))
    : null;
  if (max !== null) list = list.slice(0, max);

  const first = list.length > 0 ? list[0] : null;
  const last = list.length > 0 ? list[list.length - 1] : null;
  let span = null;
  if (first !== null && last !== null) {
    const start = Number(bySeq.get(first)?.time);
    const end = Number(bySeq.get(last)?.time);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      span = { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
    }
  }
  return { seqs: list, count: list.length, first, last, span };
}

/**
 * 一个 seq 属于哪些标签：主解析 + 所有覆盖它的 run + memberships。
 * 检索用这个（多标签），覆盖率/T0 仍用 resolveTag（单标签分区）。
 */
export function tagsAtSeq(tags, seq) {
  const state = normalizeTags(tags);
  const number = Number(seq);
  const out = new Set();
  const key = String(number);
  // 主标签：override -> 最后一个覆盖 run -> T0（与 resolveTag 一致）
  if (state.overrides[key] !== undefined) out.add(state.overrides[key]);
  else {
    let primary = null;
    for (let index = state.runs.length - 1; index >= 0; index -= 1) {
      const [from, to, id] = state.runs[index];
      if (number >= from && number <= to) { primary = id; break; }
    }
    out.add(primary ?? TAG_ZERO);
  }
  // 附加成员：只认显式 memberships（重叠 run 是父子/修正，不是多标签）
  for (const id of state.memberships?.[key] ?? []) out.add(id);
  return out;
}

/** tag({seqs,id,label?,keywords?,alias?}): exact overrides; runs are untouched. */
export function tagSeqs(tags, { seqs, id, label, keywords, alias } = {}) {
  const state = normalizeTags(tags);
  const tagId = asId(id);
  if (tagId === null) throw new Error('tag: id is required');
  if (!Array.isArray(seqs) || seqs.length === 0) throw new Error('tag: seqs must be a non-empty array');
  const values = [...new Set(seqs.map(asInteger).filter((seq) => seq !== null))];
  if (values.length === 0) throw new Error('tag: seqs must contain integer seqs');
  const requestedLabel = asId(label);
  if (state.tags[tagId] === undefined) state.tags[tagId] = normalizeEntry(tagId, {});
  if (requestedLabel !== null) state.tags[tagId].label = requestedLabel;
  if (Array.isArray(keywords)) {
    state.tags[tagId].keywords = [...new Set(keywords.map((item) => String(item).trim()).filter(Boolean))];
  }
  const requestedAlias = asId(alias);
  if (requestedAlias !== null) state.tags[tagId].alias = requestedAlias;
  for (const seq of values) state.overrides[String(seq)] = tagId;
  state.updatedAt = new Date().toISOString();
  return { state, count: values.length, seqs: values };
}

/** retag({from,to}): move every run and override from one tag to another. */
export function retagTags(tags, { from, to } = {}) {
  const state = normalizeTags(tags);
  const fromId = asId(from);
  const toId = asId(to);
  if (fromId === null || toId === null) throw new Error('retag: from and to are required');
  if (fromId === toId) throw new Error('retag: from and to must differ');
  const source = state.tags[fromId];
  if (state.tags[toId] === undefined) {
    state.tags[toId] = normalizeEntry(toId, source ?? {});
  }
  let moved = 0;
  state.runs = state.runs.map(([start, end, id]) => {
    if (id !== fromId) return [start, end, id];
    moved += 1;
    return [start, end, toId];
  });
  for (const [key, value] of Object.entries(state.overrides)) {
    if (value !== fromId) continue;
    state.overrides[key] = toId;
    moved += 1;
  }
  if (fromId !== TAG_ZERO) delete state.tags[fromId];
  state.updatedAt = new Date().toISOString();
  return { state, moved };
}

/** tags() index: label/status/keywords, coverage, entries, display, active, alias mapping. */
export function tagsView(tags, { activeId = null, threads = [], maxSeq = 0 } = {}) {
  const state = normalizeTags(tags);
  const ids = new Set([
    ...Object.keys(state.tags),
    ...state.runs.map((run) => run[2]),
    ...Object.values(state.overrides),
  ]);
  for (const [id, entry] of Object.entries(state.tags)) {
    if (entry?.lifecycle === 'merged' || entry?.lifecycle === 'archived') ids.delete(id);
  }
  const threadById = new Map();
  const aliasToThread = new Map();
  for (const thread of Array.isArray(threads) ? threads : []) {
    if (thread?.id === undefined || thread.id === null) continue;
    threadById.set(String(thread.id), thread);
    const alias = typeof thread.alias === 'string' && thread.alias.trim().length > 0 ? thread.alias.trim() : null;
    if (alias !== null) aliasToThread.set(alias, thread);
  }
  const activeThread = activeId === null ? null : threadById.get(String(activeId)) ?? null;
  const activeAlias = activeThread?.alias !== undefined && activeThread?.alias !== null
    ? String(activeThread.alias)
    : null;
  let max = Number.isFinite(Number(maxSeq)) ? Math.max(0, Math.trunc(Number(maxSeq))) : 0;
  for (const [, end] of state.runs) if (end > max) max = end;
  for (const key of Object.keys(state.overrides)) {
    const seq = Number(key);
    if (Number.isInteger(seq) && seq > max) max = seq;
  }
  const coverage = new Map();
  for (let seq = 0; seq <= max; seq += 1) {
    const key = String(seq);
    let resolved = state.overrides[key];
    if (resolved === undefined) {
      resolved = TAG_ZERO;
      for (let index = state.runs.length - 1; index >= 0; index -= 1) {
        const [from, to, id] = state.runs[index];
        if (seq >= from && seq <= to) { resolved = id; break; }
      }
    }
    coverage.set(resolved, (coverage.get(resolved) ?? 0) + 1);
  }
  const rows = [...ids].sort().map((id) => {
    const runs = state.runs.filter((run) => run[2] === id);
    const overrides = Object.entries(state.overrides).filter(([, value]) => value === id);
    const lastRun = runs.length > 0 ? runs[runs.length - 1] : null;
    const lastOverride = overrides.length > 0
      ? Math.max(...overrides.map(([key]) => Number(key)))
      : null;
    const lastSeq = Math.max(
      lastRun === null ? Number.NEGATIVE_INFINITY : lastRun[1],
      lastOverride === null ? Number.NEGATIVE_INFINITY : lastOverride,
    );
    const thread = threadById.get(id) ?? aliasToThread.get(id) ?? null;
    const explicitLabel = state.tags[id]?.label;
    const threadLabel = typeof thread?.label === 'string' && thread.label.length > 0 ? thread.label : null;
    const label = typeof explicitLabel === 'string' && explicitLabel.length > 0 && explicitLabel !== id
      ? explicitLabel
      : threadLabel;
    const alias = typeof state.tags[id]?.alias === 'string' && state.tags[id].alias.trim().length > 0
      ? state.tags[id].alias.trim()
      : typeof thread?.alias === 'string' && thread.alias.trim().length > 0
        ? thread.alias.trim()
        : null;
    const display = alias ?? label ?? (id.length > 8 ? id.slice(0, 8) : id);
    const entries = runs.length + overrides.length;
    const events = coverage.get(id) ?? 0;
    return {
      id,
      ...(label === null ? {} : { label }),
      ...(alias === null ? {} : { alias }),
      ...(thread === null ? {} : { threadId: String(thread.id) }),
      display,
      ...(state.tags[id]?.status === undefined ? {} : { status: state.tags[id].status }),
      ...(state.tags[id]?.keywords === undefined ? {} : { keywords: state.tags[id].keywords }),
      count: events,
      entries,
      events,
      runs: runs.length,
      overrides: overrides.length,
      lastSeq: Number.isFinite(lastSeq) ? lastSeq : null,
      lastRun,
      active: (activeId !== null && String(activeId) === id)
        || (activeAlias !== null && activeAlias === id),
    };
  });
  for (const thread of Array.isArray(threads) ? threads : []) {
    if (thread?.id === undefined || thread.id === null) continue;
    const id = String(thread.id);
    const alias = typeof thread.alias === 'string' && thread.alias.trim().length > 0 ? thread.alias.trim() : null;
    if (ids.has(id) || (alias !== null && ids.has(alias))) continue;
    const label = typeof thread.label === 'string' && thread.label.length > 0 ? thread.label : null;
    rows.push({
      id,
      ...(label === null ? {} : { label }),
      ...(alias === null ? {} : { alias }),
      threadId: id,
      display: alias ?? label ?? (id.length > 8 ? id.slice(0, 8) : id),
      count: 0,
      entries: 0,
      events: 0,
      runs: 0,
      overrides: 0,
      lastSeq: null,
      lastRun: null,
      active: activeId !== null && String(activeId) === id,
    });
  }
  rows.sort((left, right) => left.id.localeCompare(right.id));
  return { tags: rows, updatedAt: state.updatedAt };
}

/** Merge alias-named tag records into their canonical thread tag, then delete them. */
export function migrateAliasTags(tags, threads = []) {
  const state = normalizeTags(tags);
  const aliasToThread = new Map();
  for (const thread of Array.isArray(threads) ? threads : []) {
    if (thread?.id === undefined || thread.id === null) continue;
    const alias = asId(thread.alias);
    if (alias !== null && alias !== String(thread.id)) aliasToThread.set(alias, thread);
  }
  let movedRuns = 0;
  let movedOverrides = 0;
  let changed = false;
  for (const [alias, thread] of aliasToThread) {
    const canonical = String(thread.id);
    const aliasEntry = state.tags[alias];
    const aliasRuns = state.runs.filter((run) => run[2] === alias);
    const aliasOverrides = Object.entries(state.overrides).filter(([, id]) => id === alias);
    if (aliasEntry === undefined && aliasRuns.length === 0 && aliasOverrides.length === 0) continue;
    if (state.tags[canonical] === undefined) {
      state.tags[canonical] = normalizeEntry(canonical, {
        label: thread.label ?? aliasEntry?.label ?? canonical,
        ...(aliasEntry?.keywords === undefined ? {} : { keywords: aliasEntry.keywords }),
        alias,
      });
    } else {
      state.tags[canonical].alias = alias;
      if ((state.tags[canonical].label === undefined
        || state.tags[canonical].label.length === 0
        || state.tags[canonical].label === canonical)
        && typeof thread.label === 'string' && thread.label.length > 0) {
        state.tags[canonical].label = thread.label;
      }
    }
    state.runs = state.runs.map(([from, to, id]) => {
      if (id !== alias) return [from, to, id];
      movedRuns += 1;
      return [from, to, canonical];
    });
    for (const [key, id] of Object.entries(state.overrides)) {
      if (id !== alias) continue;
      state.overrides[key] = canonical;
      movedOverrides += 1;
    }
    delete state.tags[alias];
    changed = true;
  }
  if (changed) state.updatedAt = new Date().toISOString();
  return { state, changed, movedRuns, movedOverrides };
}

/** Fixed-template tags.md view. tags.json remains the only input source. */
export function renderTagsMd(tags, { threads = [], maxSeq = 0, activeId = null } = {}) {
  const view = tagsView(tags, { threads, maxSeq, activeId });
  const lines = [
    '# Continuity tags (generated)',
    '',
    '> Generated from tags.json by dsh-continuity. Do not edit this file; hand edits are overwritten.',
    '',
    '| 符号 | 名称 | 关键词 | 事件 | 条目 | 状态 | 线程 id |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const row of view.tags) {
    if (row.events <= 0) continue;
    const symbol = row.alias ?? row.id;
    lines.push(`| ${symbol} | ${row.label ?? row.display} | ${(row.keywords ?? []).join(', ')} | ${row.events} | ${row.entries} | ${row.status ?? ''} | ${row.threadId ?? ''} |`);
  }
  lines.push('', `updatedAt: ${view.updatedAt ?? ''}`);
  return `${lines.join('\n')}\n`;
}

/** Contiguous ranges where resolve(seq) === id, over 0..max seq. */
export function findResolvedRanges({
  tags,
  id,
  events = [],
  after = undefined,
  before = undefined,
  limit = FIND_DEFAULT_LIMIT,
} = {}) {
  const state = normalizeTags(tags);
  const tagId = asId(id);
  if (tagId === null) throw new Error('find: id is required');
  const bySeq = new Map();
  let maxSeq = 0;
  for (const event of Array.isArray(events) ? events : []) {
    const seq = asInteger(event?.seq);
    if (seq === null) continue;
    bySeq.set(seq, event);
    if (seq > maxSeq) maxSeq = seq;
  }
  for (const [, end] of state.runs) if (end > maxSeq) maxSeq = end;
  for (const key of Object.keys(state.overrides)) {
    const seq = asInteger(key);
    if (seq !== null && seq > maxSeq) maxSeq = seq;
  }
  const lower = after !== undefined && after !== null ? Number(after) + 1 : 0;
  const upper = before !== undefined && before !== null ? Number(before) - 1 : maxSeq;
  const ranges = [];
  let current = null;
  let count = 0;
  let first = null;
  let last = null;
  for (let seq = Math.max(0, lower); seq <= upper; seq += 1) {
    if (resolveTag(state, seq) !== tagId) continue;
    if (first === null) first = seq;
    last = seq;
    count += 1;
    if (current !== null && seq === current[1] + 1) current[1] = seq;
    else {
      current = [seq, seq];
      ranges.push(current);
    }
  }
  const maxRanges = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.min(FIND_MAX_LIMIT, Math.trunc(Number(limit)))
    : null;
  const visibleRanges = maxRanges === null ? ranges : ranges.slice(0, maxRanges);
  let span = null;
  if (first !== null && last !== null) {
    const start = Number(bySeq.get(first)?.time);
    const end = Number(bySeq.get(last)?.time);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      span = { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
    }
  }
  return { ranges: visibleRanges, count, first, last, span };
}

/** Complement of all non-T0 coverage over 0..max seq. Used only by find(T0). */
export function findT0Ranges(options = {}) {
  const result = findResolvedRanges({ ...options, id: TAG_ZERO });
  return {
    seqs: [],
    ranges: result.ranges,
    count: result.count,
    first: result.first,
    last: result.last,
    span: result.span,
    complement: true,
  };
}

/** Text for a tag/seq selection load; no thread-specific fields. */
export function selectionLoadText({
  id = null,
  label = null,
  display = null,
  count = 0,
  quote = '',
  indexOnly = false,
  mode = 'tag',
  first = 3,
  last = 5,
  foldedNote = null,
  withReasoning = false,
  reasoningInjected = 0,
  skipped = 0,
} = {}) {
  const title = display
    ?? (label !== null && label !== undefined && label !== id && label !== ''
      ? label
      : (id ?? label ?? '所选内容'));
  const policy = mode === 'tag'
    ? (first === 3 && last === 5
      ? '默认最早3+最新5'
      : first > 0 && last > 0
        ? `最早${first}+最新${last}`
        : first > 0 ? `最早${first}` : `最新${last}`)
    : '按指定 seqs';
  const reasoningText = withReasoning
    ? `含 reasoning${reasoningInjected} 条 · skipped ${skipped}`
    : '已去 reasoning';
  return [
    `[取] ${title} · 实际 ${count} 条 · ${policy} · ${reasoningText}`,
    ...(foldedNote !== null && foldedNote !== undefined && String(foldedNote).length > 0
      ? [`[已折叠于 gist seq=${foldedNote}]`]
      : []),
    indexOnly ? '—— 原文不可用；只有索引 ——' : '—— 以下是从原文取回的所选内容 ——',
    String(quote ?? ''),
  ].join('\n');
}
