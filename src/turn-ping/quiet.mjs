import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_QUIET_RECALL = Object.freeze({
  mode: 'quiet', tau: 0.55, delta: 0.04, noveltyThreshold: 0.75, historyWindowMs: 30 * 60_000,
});
const INTENT = /之前|先前|以前|从前|上次|那次|当时|刚才|刚刚|还记得|记得吗|我们不是说过|说过|提过|聊过|问过|回忆|想起|忘记|忘掉|历史|旧答案|旧记录|remember|previously|last\s+time|earlier|recall|forgot/i;

export function hasMemoryIntent(text) {
  return INTENT.test(String(text ?? '').trim());
}

export function readQuietConfig(config) {
  const value = config?.autoRecall ?? {};
  return {
    mode: ['quiet', 'off', 'legacy'].includes(value.mode) ? value.mode : DEFAULT_QUIET_RECALL.mode,
    tau: Number.isFinite(value.tau) && value.tau >= 0 && value.tau <= 1 ? value.tau : DEFAULT_QUIET_RECALL.tau,
    delta: Number.isFinite(value.delta) && value.delta >= 0 && value.delta <= 1 ? value.delta : DEFAULT_QUIET_RECALL.delta,
    noveltyThreshold: Number.isFinite(value.noveltyThreshold) && value.noveltyThreshold > 0 && value.noveltyThreshold <= 1 ? value.noveltyThreshold : DEFAULT_QUIET_RECALL.noveltyThreshold,
    historyWindowMs: Number.isFinite(value.historyWindowMs) && value.historyWindowMs >= 0 ? value.historyWindowMs : DEFAULT_QUIET_RECALL.historyWindowMs,
  };
}

export function memoryIdentity(summary) {
  return String(summary?.chunkId ?? summary?.turnId ?? '');
}

export function extractVisibleMemoryIds(text) {
  const ids = new Set();
  for (const match of String(text ?? '').matchAll(/\b(?:turn-[a-z0-9-]+|turn_[a-f0-9]+)\b/gi)) ids.add(match[0]);
  for (const match of String(text ?? '').matchAll(/\bHIT\s+([a-f0-9]{64})\b/g)) ids.add(match[1]);
  return ids;
}

export function cosineSimilarity(left, right) {
  const length = Math.min(left.length, right.length);
  if (!length) return 0;
  let dot = 0;
  let a = 0;
  let b = 0;
  for (let index = 0; index < length; index++) {
    dot += left[index] * right[index];
    a += left[index] * left[index];
    b += right[index] * right[index];
  }
  return dot / Math.sqrt(a * b || 1);
}

/** Dynamic count: no fixed one-hit rule; relevance and novelty are separate gates. */
export function selectNovelHits(hits, referenceVectors, threshold = DEFAULT_QUIET_RECALL.noveltyThreshold) {
  const selected = [];
  const references = referenceVectors.filter(vector => Array.isArray(vector) && vector.length > 0 && vector.every(Number.isFinite));
  for (const hit of [...hits].sort((left, right) => right.score - left.score)) {
    const vector = hit.vector ?? hit.summary?.vector;
    if (!Array.isArray(vector) || !vector.length || !vector.every(Number.isFinite)) continue;
    if (references.length && Math.max(...references.map(reference => cosineSimilarity(vector, reference))) >= threshold) continue;
    selected.push(hit);
    references.push(vector);
  }
  return selected;
}

function historyFile(root) { return path.join(root, 'cue-history.json'); }
function readHistory(root) {
  const file = historyFile(root);
  if (!fs.existsSync(file)) return [];
  try {
    const row = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(row?.entries) ? row.entries.filter(entry => typeof entry.turnId === 'string' && Number.isFinite(entry.injectedAt)) : [];
  } catch { return []; }
}

export function recentCueIds(root, now = Date.now(), windowMs = DEFAULT_QUIET_RECALL.historyWindowMs) {
  return new Set(readHistory(root).filter(entry => now - entry.injectedAt <= windowMs).map(entry => entry.turnId));
}

export function markCueHistory(root, ids, now = Date.now()) {
  const byId = new Map(readHistory(root).map(entry => [entry.turnId, entry]));
  for (const id of ids) byId.set(id, { turnId: id, injectedAt: now });
  const entries = [...byId.values()].sort((left, right) => left.injectedAt - right.injectedAt).slice(-500);
  fs.mkdirSync(root, { recursive: true });
  const file = historyFile(root);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ entries }, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

export function recordCueDecision(root, row) {
  try { fs.appendFileSync(path.join(root, 'cue-decisions.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`, 'utf8'); }
  catch { /* diagnostics never block delivery */ }
}
