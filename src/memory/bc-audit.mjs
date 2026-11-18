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

const CJK = /[\u3400-\u9fff]/;
const IDENTIFIER = /^(?:[a-z][a-z0-9]*(?:_[a-z0-9]+)+|[a-z]+[0-9]+|[0-9a-f]{8,}|[a-z]+(?:id|uuid|hash))$/i;
const NOISE = new Set(['revision', 'actionid', 'sessionid', 'session', 'compact', 'turn', 'seq', 'json', 'tool', 'result', 'state', 'true', 'false', 'null']);

function termKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

function isUsefulTerm(value) {
  const term = String(value ?? '').trim();
  if (!term) return false;
  if (NOISE.has(termKey(term))) return false;
  if (IDENTIFIER.test(term)) return false;
  if (/[0-9a-f]{8}-[0-9a-f-]{8,}/i.test(term)) return false;
  // Tokenizer output is mostly lowercase English; those are commands/identifiers,
  // not new proper names. Keep CJK terms and capitalized names.
  if (!CJK.test(term) && /^[a-z][a-z0-9_-]*$/.test(term)) return false;
  return CJK.test(term) || term.length >= 3;
}

function topEntry(record) {
  return Object.entries(record?.conceptScores ?? {})
    .sort((a, b) => Number(b[1]) - Number(a[1]))[0] ?? ['', 0];
}

function topConcept(record) {
  return topEntry(record)[0];
}

function marginOf(record) {
  if (Number.isFinite(Number(record?.scoreMargin))) return Number(record.scoreMargin);
  const entries = Object.entries(record?.conceptScores ?? {})
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  return Number(entries[0]?.[1] ?? 0) - Number(entries[1]?.[1] ?? 0);
}

function segmentFeatures(members, conceptLabels, newConcepts) {
  const size = Math.max(1, members.length);
  const isWeak = (m) => Number(m.confidence ?? 0) === 0 || Object.keys(m.conceptScores ?? {}).length === 0;
  const empty = members.filter(isWeak).length;
  let emptyTail = 0;
  for (let i = members.length - 1; i >= 0 && isWeak(members[i]); i -= 1) emptyTail += 1;
  let uncertainTail = 0;
  for (let i = members.length - 1; i >= 0; i -= 1) {
    if (marginOf(members[i]) < 0.03) uncertainTail += 1;
    else break;
  }
  const prior = members.at(-2);
  const last = members.at(-1);
  const priorTop = Number(topEntry(prior)[1]);
  const lastTop = Number(topEntry(last)[1]);
  const sharpDrop = priorTop >= 0.55 && lastTop > 0 && lastTop < 0.4;
  const priorLabel = topConcept(prior);
  const lastLabel = topConcept(last);
  const topicShift = Boolean(priorLabel && lastLabel && priorLabel !== lastLabel
    && priorTop >= 0.4 && lastTop >= 0.4);
  const bleed = members.filter((m) => newConcepts.has(topConcept(m))).length;
  const vocab = new Set(conceptLabels.map(termKey));
  const newTermTurns = members.filter((m) => {
    const terms = [...(m.terms ?? []), ...(m.keywords ?? [])].map(termKey);
    return terms.some((term) => term && !vocab.has(term) && isUsefulTerm(term));
  }).length;
  return {
    emptyRate: empty / size,
    emptyTail,
    uncertainTail,
    sharpDrop,
    topicShift,
    bleedRate: bleed / size,
    newTermRate: newTermTurns / size,
  };
}

function candidateScore(features, topicMax) {
  const topicGap = Math.max(0, Math.min(1, 1 - Number(topicMax ?? 0)));
  return 0.35 * features.emptyRate
    + 0.30 * features.bleedRate
    + 0.20 * features.newTermRate
    + 0.15 * topicGap;
}
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

function reviewPaths(indexFile) {
  return { stateFile: path.join(path.dirname(indexFile), 'recent-review.json') };
}

/**
 * Review is a repair turn, not a report. `memory_repair` is the write side;
 * a reply without a write (or an explicit blocked reason) is not a pass.
 */
function reviewDirective(start, end, flags, details = {}) {
  const aLabels = Array.isArray(details.aLabels) ? details.aLabels : [];
  const recentTop = Array.isArray(details.recentTop) ? details.recentTop : [];
  const emptyTurns = Array.isArray(details.emptyTurns) ? details.emptyTurns : [];
  return `[continuity:review] 快速校验 turn ${start}-${end}（${flags.join(' / ') || 'weak'}）。\n`
    + `现有 A：${aLabels.length > 0 ? aLabels.join(' / ') : '（空）'}\n`
    + `最近 top：${recentTop.length > 0 ? recentTop.join('；') : '（无）'}\n`
    + `空/低 turns：${emptyTurns.length > 0 ? emptyTurns.join(',') : '（无）'}\n`
    + `先诊断，不要直接新建。按顺序判断：\n`
    + `1 旧 A 在旧段仍成立，且新段明显不同 -> concept_add 1 条新 A，旧 A 保留。\n`
    + `2 旧 A 在旧段也不成立，或新段与旧 A 大面积重叠 -> concept_update 修旧 A，或 concept_merge；不要新建。\n`
    + `3 证据不足，或这段本身没有可分离话题 -> review: abstain <原因>；不要为了覆盖硬建 A。\n`
    + `同域前缀默认 update/merge；一次 review 最多 add 1 条 A；多原型用 ";;" 分隔。\n`
    + `先用 concept_propose 看目标 turn 的独特词与现有 A；再写 2-3 个候选原型。\n`
    + `新建/重写前逐个 concept_trial(label, description, startTurn, endTurn)；passed=false 就 abstain 或改候选，passed=true 才 memory_repair。\n`
    + `memory_repair 也传同一个 startTurn/endTurn；质量门现在按 target + held-out + 兄弟 A 验收。\n`
    + `memory_repair 改 A 后会自动 relabel 并验收；quality.passed=false 表示已回退或分不开。\n`
    + `修完只回：review: fixed <实际改了什么；失败就写 blocked/blocked-relabel>。\n`
    + `不要展开、不要另开 turn；回完继续用户请求。`;
}

/**
 * Cheap per-turn gate. No kmeans, no embeddings.
 * Returns a short one-shot review directive only when the recent window is
 * clearly weak, and at most once per cooldown turns.
 */
export function buildRecentReview({ indexFile, conceptsFile = null, records = [], window = 24, cooldown = 12 } = {}) {
  if (!indexFile || records.length < 8) return null;
  const recent = records.slice(-window);
  const lastTurn = Number(recent.at(-1)?.turn);
  if (!Number.isInteger(lastTurn)) return null;
  const state = readAuditState(indexFile);
  const prior = Array.isArray(state.conceptsAtLastAudit) ? state.conceptsAtLastAudit.map(String) : [];
  const rows = loadConcepts(conceptsFile ?? defaultConceptsPath());
  const concepts = rows.map((row) => row.label);
  const newConcepts = prior.length > 0
    ? new Set(concepts.filter((label) => !prior.includes(String(label))))
    : new Set();
  const features = segmentFeatures(recent, concepts, newConcepts);
  const bleedTurns = Math.round(features.bleedRate * recent.length);
  const urgent = features.emptyTail >= 4 || features.uncertainTail >= 2 || features.sharpDrop;
  const strong = features.emptyRate >= 0.3 || urgent || features.topicShift
    || (newConcepts.size > 0 && bleedTurns >= 2);
  if (!strong) return null;

  const reviewState = readJson(reviewPaths(indexFile).stateFile, null);
  const signature = recent.slice(-8).map((row) => {
    const [label, score] = topEntry(row);
    return `${row.turn}:${label}:${Number(score).toFixed(3)}:${marginOf(row).toFixed(3)}`;
  }).join('|');
  // Same unresolved window, same evidence: don't ask the same question again.
  if (reviewState?.signature === signature) return null;
  const lastReviewTurn = Number(reviewState?.lastTurn ?? 0);
  // A short unstable tail is urgent, but still has a floor so an unresolved
  // review is not repeated every single turn.
  const effectiveCooldown = urgent ? Math.min(4, cooldown) : cooldown;
  if (Number.isFinite(lastReviewTurn) && lastTurn - lastReviewTurn < effectiveCooldown) return null;

  const flags = [];
  if (features.emptyRate >= 0.3) flags.push(`empty ${features.emptyRate.toFixed(2)}`);
  if (features.emptyTail >= 4) flags.push(`empty-tail ${features.emptyTail}`);
  if (features.uncertainTail >= 2) flags.push(`uncertain-tail ${features.uncertainTail}`);
  if (features.sharpDrop) flags.push('sharp-drop');
  if (features.topicShift) flags.push('topic-shift');
  if (bleedTurns >= 2) flags.push(`bleed ${bleedTurns}轮`);
  const start = recent[0]?.turn ?? lastTurn;
  const isWeak = (row) => Number(row?.confidence ?? 0) === 0 || Object.keys(row?.conceptScores ?? {}).length === 0;
  const recentTop = recent.slice(-8).map((row) => {
    const [label, score] = topEntry(row);
    return `${row.turn}:${label || '-'}:${Number(score).toFixed(2)}/m${marginOf(row).toFixed(2)}`;
  });
  const emptyTurns = recent.filter(isWeak).slice(-8).map((row) => row.turn);
  const text = reviewDirective(start, lastTurn, flags, { aLabels: concepts, recentTop, emptyTurns });
  writeJson(reviewPaths(indexFile).stateFile, { lastTurn, at: new Date().toISOString(), signature });
  return {
    text,
    range: [start, lastTurn],
    emptyRate: features.emptyRate,
    emptyTail: features.emptyTail,
    uncertainTail: features.uncertainTail,
    sharpDrop: features.sharpDrop,
    bleedTurns,
  };
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
  const state = readAuditState(indexFile);
  const priorConcepts = Array.isArray(state.conceptsAtLastAudit) ? state.conceptsAtLastAudit.map(String) : [];
  // First run after upgrading has no baseline. Do not call every existing concept "new".
  const newConcepts = priorConcepts.length > 0
    ? new Set(concepts.filter((label) => !priorConcepts.includes(String(label))))
    : new Set();
  const at = new Date().toISOString();

  const buildCandidate = (members, extra = {}) => {
    const recordsIn = members.map((point) => point.record ?? point);
    const turns = recordsIn.map((record) => record.turn).sort((a, b) => a - b);
    const topicMax = recordsIn.reduce((sum, record) => {
      const scores = record.conceptScores ?? {};
      return sum + Math.max(0, ...concepts.map((name) => scores[name] ?? 0));
    }, 0) / Math.max(1, recordsIn.length);
    const chatter = recordsIn.reduce((sum, record) => sum + (record.chatter ?? 0), 0) / Math.max(1, recordsIn.length);
    const kw = [...new Set(recordsIn.flatMap((record) => record.keywords ?? []))].slice(0, 6);
    const features = segmentFeatures(recordsIn, concepts, newConcepts);
    return {
      start: turns[0], end: turns.at(-1), size: turns.length, topicMax, chatter, kw,
      ...features,
      score: candidateScore(features, topicMax),
      ...extra,
    };
  };

  const clusters = groups.filter((group) => group.members.length >= 10)
    .map((group) => buildCandidate(group.members));

  const recentWindow = records.slice(-40);
  const recentCandidate = recentWindow.length > 0 ? buildCandidate(recentWindow, { recent: true }) : null;
  const recentIsStrong = Boolean(recentCandidate && (
    recentCandidate.emptyRate >= 0.3
    || recentCandidate.bleedRate >= 0.15
    || recentCandidate.newTermRate >= 0.2
  ));

  const historical = clusters
    .filter((cluster) => cluster.topicMax < 0.5)
    .sort((a, b) => b.score - a.score || a.topicMax - b.topicMax || b.size - a.size);

  const candidates = [];
  if (recentIsStrong) candidates.push(recentCandidate);
  for (const candidate of historical) {
    if (candidates.length >= 5) break;
    if (candidates.some((item) => item.start === candidate.start && item.end === candidate.end)) continue;
    candidates.push(candidate);
  }
  if (candidates.length === 0 && recentCandidate) candidates.push(recentCandidate);
  if (candidates.length > 0) {
    const lines = candidates.map((item) => ({
      at, event: 'pending', range: [item.start, item.end], size: item.size,
      topicMax: Number(item.topicMax.toFixed(2)), chatter: Number(item.chatter.toFixed(2)), kw: item.kw,
      emptyRate: Number(item.emptyRate.toFixed(2)), bleed: Number(item.bleedRate.toFixed(2)),
      newTermRate: Number(item.newTermRate.toFixed(2)), score: Number(item.score.toFixed(3)),
      recent: Boolean(item.recent),
    }));
    fs.appendFileSync(auditPaths(indexFile).hintFile, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
    const strongest = candidates[0];
    const flags = [];
    if (strongest.emptyRate >= 0.3) flags.push(`empty ${strongest.emptyRate.toFixed(2)}`);
    if (strongest.bleedRate >= 0.15) flags.push(`bleed ${strongest.bleedRate.toFixed(2)}`);
    if (strongest.newTermRate >= 0.2) flags.push(`newTerm ${strongest.newTermRate.toFixed(2)}`);
    const text = reviewDirective(strongest.start, strongest.end, flags, { aLabels: concepts });
    writeJson(auditPaths(indexFile).pendingFile, { at, text, review: true, range: [strongest.start, strongest.end] });
  }
  writeJson(auditPaths(indexFile).stateFile, {
    lastAuditTurn: records.at(-1)?.turn ?? state.lastAuditTurn ?? 0,
    nextAuditTurn: (records.at(-1)?.turn ?? 0) + 200,
    lastResult: candidates.length > 0 ? 'candidates' : 'no-candidates',
    candidates: candidates.length,
    conceptsAtLastAudit: concepts,
    at,
    running: false,
    runningAt: null,
  });
  return { candidates: candidates.length };
}
