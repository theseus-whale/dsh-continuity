/**
 * Automatic, non-blocking expand-hint audit.
 *
 * Uses vec + chatter + keywords already stored in bc-index.
 * Writes only expand-hint.jsonl + expand-hint.pending.json + audit-state.json.
 * Never changes concepts or the index.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadIndexJsonl } from './bc-index.mjs';
import { loadConcepts, defaultConceptsPath } from './concepts-file.mjs';

const norm = (v) => {
  const n = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1;
  return v.map((x) => x / n);
};
const cos = (a, b) => {
  let dot = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) dot += a[i] * b[i];
  return dot;
};
const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
};
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};
const decodeVec = (text) => {
  if (typeof text !== 'string' || text.length === 0) throw new Error('audit: empty vector');
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new Error('audit: invalid base64');
  const buffer = Buffer.from(text, 'base64');
  if (buffer.length === 0 || buffer.length % 4 !== 0) throw new Error('audit: invalid vector length');
  const values = Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4));
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new Error('audit: vector contains non-finite values');
  }
  if (values.every((value) => value === 0)) throw new Error('audit: zero vector');
  return values;
};

export function auditPaths(indexFile) {
  const dir = path.dirname(indexFile);
  return {
    stateFile: path.join(dir, 'audit-state.json'),
    hintFile: path.join(dir, 'expand-hint.jsonl'),
    pendingFile: path.join(dir, 'expand-hint.pending.json'),
  };
}

export function readAuditState(indexFile) {
  const value = readJson(auditPaths(indexFile).stateFile, null);
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : { lastAuditTurn: 0 };
}

const AUDIT_RUNNING_TTL_MS = 15 * 60 * 1000;
const auditLockFile = (indexFile) => path.join(path.dirname(indexFile), 'audit.lock');

function acquireAuditLock(indexFile) {
  const file = auditLockFile(indexFile);
  const token = randomUUID();
  try {
    const fd = fs.openSync(file, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, at: Date.now() }));
    fs.closeSync(fd);
    return token;
  } catch (error) {
    if (error?.code !== 'EEXIST') return null;
    try {
      const stat = fs.statSync(file);
      const future = stat.mtimeMs > Date.now() + 5 * 60 * 1000;
      if (!future && Date.now() - stat.mtimeMs <= AUDIT_RUNNING_TTL_MS) return null;
      const stale = readJson(file, null);
      if (!stale || typeof stale !== 'object') return null;
      const quarantine = `${file}.stale.${process.pid}.${randomUUID()}`;
      fs.renameSync(file, quarantine);
      const moved = readJson(quarantine, null);
      if (moved?.token !== stale.token) {
        try { fs.renameSync(quarantine, file); } catch { /* lost race */ }
        return null;
      }
      try { fs.unlinkSync(quarantine); } catch { /* ignore */ }
      return acquireAuditLock(indexFile);
    } catch {
      return null;
    }
  }
}

function releaseAuditLock(indexFile, token) {
  const file = auditLockFile(indexFile);
  try {
    const current = readJson(file, null);
    if (current?.token !== token) return false;
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

export function consumePendingHint(indexFile) {
  const { pendingFile, hintFile } = auditPaths(indexFile);
  const pending = readJson(pendingFile, null);
  if (!pending || typeof pending.text !== 'string' || !pending.text) return null;
  try { fs.unlinkSync(pendingFile); } catch { /* ignore */ }
  try {
    fs.appendFileSync(hintFile, `${JSON.stringify({ at: new Date().toISOString(), event: 'delivered', text: pending.text })}\n`, 'utf8');
  } catch { /* ignore */ }
  return pending.text;
}

export function maybeRunAudit({ indexFile, conceptsFile = null, lastTurn, onError = null } = {}) {
  if (!Number.isInteger(lastTurn)) return false;
  let state = readAuditState(indexFile);
  if (lastTurn - (state.lastAuditTurn ?? 0) < 200) return false;
  if (state.running === true) {
    const startedAt = Number(state.runningAt ?? 0);
    const future = startedAt > Date.now() + 5 * 60 * 1000;
    const stale = !Number.isFinite(startedAt) || startedAt <= 0 || future || Date.now() - startedAt > AUDIT_RUNNING_TTL_MS;
    if (!stale) return false;
  }
  const token = acquireAuditLock(indexFile);
  if (!token) return false;
  try {
    state = readAuditState(indexFile);
    if (lastTurn - (state.lastAuditTurn ?? 0) < 200) {
      releaseAuditLock(indexFile, token);
      return false;
    }
    if (state.running === true) {
      const startedAt = Number(state.runningAt ?? 0);
      const future = startedAt > Date.now() + 5 * 60 * 1000;
      const stale = !Number.isFinite(startedAt) || startedAt <= 0 || future || Date.now() - startedAt > AUDIT_RUNNING_TTL_MS;
      if (!stale) {
        releaseAuditLock(indexFile, token);
        return false;
      }
      state = { ...state, running: false, runningAt: null, recoveredAt: new Date().toISOString() };
    }
    writeJson(auditPaths(indexFile).stateFile, { ...state, running: true, runningAt: Date.now() });
    setImmediate(() => {
      runAudit({ indexFile, conceptsFile })
        .then(() => releaseAuditLock(indexFile, token))
        .catch((error) => {
          try { onError?.(error); } catch { /* ignore */ }
          writeJson(auditPaths(indexFile).stateFile, { ...readAuditState(indexFile), running: false, runningAt: null, lastError: String(error?.message ?? error) });
          releaseAuditLock(indexFile, token);
        });
    });
    return true;
  } catch {
    releaseAuditLock(indexFile, token);
    return false;
  }
}

export async function runAudit({ indexFile, conceptsFile } = {}) {
  const records = loadIndexJsonl(indexFile);
  const rows = loadConcepts(conceptsFile ?? defaultConceptsPath());
  if (records.length === 0 || rows.length === 0) throw new Error('audit needs records and concepts');
  const withVec = records.filter((record) => typeof record.vec === 'string' && record.vec.length > 0);
  const missing = records.length - withVec.length;
  if (withVec.length === 0 || missing / records.length > 0.1) {
    throw new Error(`audit needs vec on at least 90% of records (${withVec.length}/${records.length})`);
  }
  const concepts = rows.map((row) => row.label);
  const points = [];
  let dimension = null;
  for (const record of withVec) {
    const values = decodeVec(record.vec);
    if (dimension === null) dimension = values.length;
    else if (values.length !== dimension) throw new Error(`audit: mixed vector dimensions (${dimension} vs ${values.length})`);
    points.push({ turn: record.turn, v: norm(values), record });
  }
  const k = Math.min(points.length, Math.max(20, Math.min(60, Math.round(points.length / 50))));
  let seed = 42;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const centers = [];
  const used = new Set();
  while (centers.length < k) {
    const index = Math.floor(rand() * points.length);
    if (used.has(index)) continue;
    used.add(index);
    centers.push(points[index].v);
  }
  let groups = [];
  for (let iteration = 0; iteration < 12; iteration += 1) {
    groups = centers.map((center) => ({ center, members: [] }));
    for (const point of points) {
      let best = 0;
      let bestScore = -Infinity;
      for (let c = 0; c < centers.length; c += 1) {
        const score = cos(point.v, centers[c]);
        if (score > bestScore) { bestScore = score; best = c; }
      }
      groups[best].members.push(point);
    }
    for (let c = 0; c < centers.length; c += 1) {
      if (groups[c].members.length === 0) continue;
      const sum = new Array(points[0].v.length).fill(0);
      for (const point of groups[c].members) for (let i = 0; i < sum.length; i += 1) sum[i] += point.v[i];
      centers[c] = norm(sum);
    }
  }
  const clusters = groups.filter((group) => group.members.length >= 10).map((group) => {
    const members = group.members;
    const topicMax = members.reduce((sum, point) => {
      const scores = point.record.conceptScores ?? {};
      return sum + Math.max(0, ...concepts.map((name) => scores[name] ?? 0));
    }, 0) / members.length;
    const chatter = members.reduce((sum, point) => sum + (point.record.chatter ?? 0), 0) / members.length;
    const turns = members.map((point) => point.turn).sort((a, b) => a - b);
    const kw = [...new Set(members.flatMap((point) => point.record.keywords ?? []))].slice(0, 6);
    return { start: turns[0], end: turns.at(-1), size: turns.length, topicMax, chatter, kw };
  });
  const candidates = clusters.filter((cluster) => cluster.topicMax < 0.5)
    .sort((a, b) => a.topicMax - b.topicMax || b.size - a.size).slice(0, 5);
  const state = readAuditState(indexFile);
  const at = new Date().toISOString();
  if (candidates.length > 0) {
    const lines = candidates.map((item) => ({
      at, event: 'pending', range: [item.start, item.end], size: item.size,
      topicMax: Number(item.topicMax.toFixed(2)), chatter: Number(item.chatter.toFixed(2)), kw: item.kw,
    }));
    fs.appendFileSync(auditPaths(indexFile).hintFile, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
    const hint = '    → topicMax<0.5 且 kw 是话题词（非人名/道具/英文标识符）才考虑加；加就一步：concepts.md 追加 `名字 | 词1、词2… | 覆盖估算`';
    const text = `[continuity:audit] 距上次 200 轮，${candidates.length} 个候选：\n`
      + candidates.map((item) => `- turn ${item.start}-${item.end} · ${item.size}轮 · topicMax ${item.topicMax.toFixed(2)} · chatter ${item.chatter.toFixed(2)} · kw ${item.kw.join('/')}\n${hint}`).join('\n');
    writeJson(auditPaths(indexFile).pendingFile, { at, text });
  }
  writeJson(auditPaths(indexFile).stateFile, {
    lastAuditTurn: records.at(-1)?.turn ?? state.lastAuditTurn ?? 0,
    nextAuditTurn: (records.at(-1)?.turn ?? 0) + 200,
    lastResult: candidates.length > 0 ? 'candidates' : 'no-candidates',
    candidates: candidates.length,
    at,
    running: false,
    runningAt: null,
  });
  return { candidates: candidates.length };
}
