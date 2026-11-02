/**
 * Deterministic tag maintenance (0.8.57).
 *
 * No model calls. The only semantic-looking step is a conservative merge:
 * it requires run containment, keyword/label overlap, a higher-use target and
 * a clear margin. Everything else is data hygiene.
 */
import fs from 'node:fs';
import path from 'node:path';
import { copyFile, mkdir } from 'node:fs/promises';
import { continuityHome, readTags, updateTags, writeTagsMd } from './tags-store.mjs';
import { canonicalTagId, normalizeTags, renderTagsMd } from './tags.mjs';

function readTurnUse(home) {
  const use = new Map();
  try {
    const text = fs.readFileSync(path.join(home, 'turn-tags.jsonl'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (typeof row?.tag !== 'string') continue;
        const current = use.get(row.tag) ?? { count: 0, lastTurn: 0 };
        current.count += 1;
        current.lastTurn = Math.max(current.lastTurn, Number(row.turn) || 0);
        use.set(row.tag, current);
      } catch { /* skip malformed row */ }
    }
  } catch { /* no turn tags yet */ }
  return use;
}

function tagRuns(state) {
  const runs = new Map();
  for (const [start, end, id] of state.runs ?? []) {
    if (typeof id !== 'string') continue;
    if (!runs.has(id)) runs.set(id, []);
    runs.get(id).push([start, end]);
  }
  return runs;
}

function hasAnySeq(state, id, runs) {
  if ((runs.get(id) ?? []).length > 0) return true;
  if (Object.values(state.overrides ?? {}).includes(id)) return true;
  return Object.values(state.memberships ?? {}).some((ids) => Array.isArray(ids) && ids.includes(id));
}

function nextNumericAlias(state) {
  let max = 0;
  for (const entry of Object.values(state.tags ?? {})) {
    const match = /^T(\d+)$/.exec(String(entry?.alias ?? ''));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

function runsInside(sourceRuns, targetRuns) {
  if (sourceRuns.length === 0 || targetRuns.length === 0) return false;
  const strict = sourceRuns.every(([s, e]) => targetRuns.some(([ts, te]) => s >= ts && e <= te));
  if (strict) return true;
  const start = Math.min(...targetRuns.map(([s]) => s));
  const end = Math.max(...targetRuns.map(([, e]) => e));
  return sourceRuns.every(([s, e]) => s >= start && e <= end);
}

function keywordScore(source, target) {
  const keys = target.keywords.map((k) => k.toLowerCase());
  let score = 0;
  for (const raw of source.keywords.map((k) => k.toLowerCase())) {
    if (keys.includes(raw)) score += 2;
    else if (keys.some((k) => k.includes(raw) || raw.includes(k))) score += 1;
  }
  return score;
}

function score(source, target, runs) {
  let value = 0;
  const reasons = [];
  if (runsInside(runs.get(source.id) ?? [], runs.get(target.id) ?? [])) {
    value += 3;
    reasons.push('run-contained');
  }
  const kw = keywordScore(source, target);
  if (kw > 0) {
    value += kw;
    reasons.push(`kw:${kw}`);
  }
  const sl = source.label.toLowerCase();
  const tl = target.label.toLowerCase();
  if (sl.includes(tl) || tl.includes(sl)) {
    value += 2;
    reasons.push('label-contains');
  }
  return { value, reasons };
}

export function planMaintenance(stateInput, use, nowTurn = 0) {
  const state = normalizeTags(stateInput);
  const runs = tagRuns(state);
  const rows = Object.entries(state.tags ?? {})
    .filter(([id, entry]) => id !== 'T0' && entry?.lifecycle !== 'merged' && entry?.lifecycle !== 'archived')
    .map(([id, entry]) => ({
      id,
      label: String(entry?.label ?? id),
      alias: String(entry?.alias ?? ''),
      keywords: Array.isArray(entry?.keywords) ? entry.keywords.map(String) : [],
      use: use.get(id)?.count ?? 0,
      lastTurn: use.get(id)?.lastTurn ?? 0,
      lifecycle: entry?.lifecycle,
      runs: runs.get(id) ?? [],
    }));

  const expired = nowTurn > 0
    ? rows.filter((row) => row.lifecycle === 'provisional' && row.use <= 1 && nowTurn - row.lastTurn > 20)
    : [];
  const expiredIds = new Set(expired.map((row) => row.id));
  const ghosts = rows.filter((row) => !expiredIds.has(row.id) && row.use === 0 && !hasAnySeq(state, row.id, runs));
  const active = rows.filter((row) => !expiredIds.has(row.id) && (row.use > 0 || hasAnySeq(state, row.id, runs)));

  active.sort((a, b) => b.use - a.use || a.id.localeCompare(b.id));
  let alias = nextNumericAlias(state);
  const aliasFixes = [];
  for (const row of active) {
    if (/^T\d+$/.test(row.alias)) continue;
    row.newAlias = `T${alias}`;
    alias += 1;
    aliasFixes.push(row);
  }

  const byId = new Map(active.map((row) => [row.id, row]));
  const merges = [];
  const orphans = [];
  for (const source of active.filter((row) => row.use <= 10 && row.runs.length <= 3)) {
    const ranked = active
      .filter((row) => row.id !== source.id && row.use > source.use)
      .map((row) => ({ target: row, ...score(source, row, runs) }))
      .sort((a, b) => b.value - a.value || b.target.use - a.target.use);
    const top = ranked[0] ?? null;
    const second = ranked[1] ?? null;
    const margin = top ? top.value - (second?.value ?? 0) : 0;
    if (top !== null && top.value >= 4 && margin >= 1) {
      merges.push({ source, target: top.target, score: top.value, reasons: top.reasons });
    } else {
      orphans.push({ source, top, margin });
    }
  }

  return { state, rows, ghosts, expired, active, aliasFixes, merges, orphans, byId };
}

export async function applyMaintenance(plan) {
  const state = structuredClone(plan.state);
  const runUse = new Map(plan.rows.map((row) => [row.id, row.use]));

  for (const ghost of plan.ghosts) {
    if (state.tags[ghost.id] === undefined) continue;
    state.tags[ghost.id].lifecycle = 'archived';
    state.tags[ghost.id].useCount = 0;
  }
  for (const expired of plan.expired) {
    const entry = state.tags[expired.id];
    if (entry === undefined) continue;
    entry.lifecycle = 'archived';
    entry.mergedInto = 'T0';
    entry.useCount = runUse.get(expired.id) ?? 0;
  }
  for (const fix of plan.aliasFixes) {
    const entry = state.tags[fix.id];
    if (entry === undefined) continue;
    const old = String(entry.alias ?? '').trim();
    if (old.length > 0) entry.legacyAliases = [...new Set([...(entry.legacyAliases ?? []), old])];
    entry.alias = fix.newAlias;
  }
  for (const merge of plan.merges) {
    const source = state.tags[merge.source.id];
    const target = state.tags[merge.target.id];
    if (source === undefined || target === undefined) continue;
    source.lifecycle = 'merged';
    source.mergedInto = merge.target.id;
    source.useCount = runUse.get(source.id) ?? source.useCount ?? 0;
    target.mergedFrom = [...new Set([...(target.mergedFrom ?? []), source.id])];
    target.useCount = (target.useCount ?? runUse.get(target.id) ?? 0) + (runUse.get(source.id) ?? 0);
  }
  const mergedInto = new Map([
    ...plan.merges.map((merge) => [merge.source.id, merge.target.id]),
    ...plan.expired.map((row) => [row.id, 'T0']),
  ]);
  state.runs = (state.runs ?? [])
    .map(([start, end, id]) => [start, end, mergedInto.get(id) ?? id])
    .map(([start, end, id]) => [`${start}-${end}-${id}`, [start, end, id]])
    .filter(([key], index, list) => list.findIndex(([other]) => other === key) === index)
    .map(([, run]) => run)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [seq, id] of Object.entries(state.overrides ?? {})) {
    state.overrides[seq] = mergedInto.get(id) ?? id;
  }
  for (const [seq, ids] of Object.entries(state.memberships ?? {})) {
    state.memberships[seq] = [...new Set(ids.map((id) => mergedInto.get(id) ?? id))];
  }
  for (const row of plan.active) {
    const entry = state.tags[row.id];
    if (entry === undefined) continue;
    entry.useCount = runUse.get(row.id) ?? 0;
    if (entry.lifecycle === undefined) entry.lifecycle = 'active';
    if (entry.lifecycle === 'provisional' && (entry.useCount ?? 0) >= 2) entry.lifecycle = 'active';
  }
  state.updatedAt = new Date().toISOString();
  return normalizeTags(state);
}

function verify(plan, next) {
  const problems = [];
  const nextRuns = tagRuns(next);
  for (const merge of plan.merges) {
    const targetId = canonicalTagId(next, merge.target.id);
    const covered = (merge.source.runs ?? []).every(([s, e]) => (nextRuns.get(targetId) ?? [])
      .some(([ts, te]) => s >= ts && e <= te));
    if (!covered) problems.push(`seq-not-covered:${merge.source.id}->${targetId}`);
  }
  for (const expired of plan.expired) {
    const covered = (expired.runs ?? []).every(([s, e]) => (nextRuns.get('T0') ?? [])
      .some(([ts, te]) => s >= ts && e <= te));
    if (!covered) problems.push(`expired-seq-not-covered:${expired.id}`);
  }
  for (const row of plan.active) {
    const entry = next.tags[row.id];
    if (entry?.mergedInto !== undefined && next.tags[entry.mergedInto] === undefined) {
      problems.push(`missing-merge-target:${row.id}->${entry.mergedInto}`);
    }
  }
  return problems;
}

export async function runMaintenance({ home = continuityHome(), mode = 'manual', dryRun = false } = {}) {
  const read = await readTags(home);
  const use = readTurnUse(home);
  const nowTurn = [...use.values()].reduce((max, item) => Math.max(max, item.lastTurn), 0);
  const plan = planMaintenance(read.state, use, nowTurn);
  const changed = plan.ghosts.length + plan.expired.length + plan.aliasFixes.length + plan.merges.length;
  const result = {
    mode,
    dryRun,
    total: plan.rows.length,
    active: plan.active.length,
    ghosts: plan.ghosts.length,
    expired: plan.expired.length,
    aliasFixes: plan.aliasFixes.length,
    merged: plan.merges.length,
    orphans: plan.orphans.length,
    changed,
    healthy: true,
    problems: [],
    merges: plan.merges.map((merge) => ({
      source: merge.source.id,
      target: merge.target.id,
      score: merge.score,
      reasons: merge.reasons,
    })),
  };
  if (changed === 0) {
    result.final = plan.rows.length;
    return result;
  }
  if (dryRun) {
    result.final = plan.rows.length - plan.ghosts.length - plan.expired.length - plan.merges.length;
    return result;
  }

  const dir = home;
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(dir, `tags.json.bak-maintenance-${stamp}`);
  try { await copyFile(path.join(dir, 'tags.json'), backup); } catch { /* first run */ }

  const next = await applyMaintenance(plan);
  result.problems = verify(plan, next);
  result.healthy = result.problems.length === 0;
  await updateTags(() => next, home);
  await writeTagsMd(renderTagsMd(next, { maxSeq: 0 }), home);
  result.final = Object.entries(next.tags).filter(([id, entry]) => id !== 'T0'
    && entry?.lifecycle !== 'merged' && entry?.lifecycle !== 'archived').length;
  result.backup = backup;
  return result;
}
