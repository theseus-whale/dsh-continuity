import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const RULE_CUE_SOURCE = 'rule-cue';
export const RULE_CUE_RETIRED_SOURCE = 'rule-cue-retired';

export const DEFAULT_RULE_CUE = Object.freeze({
  mode: 'shadow', tau: 0.56, delta: 0.06, noveltyThreshold: 0.75, historyWindowMs: 1_800_000,
  liveSessionIds: Object.freeze([]),
});

export function readRuleCueConfig(config = {}) {
  const value = config.ruleCue ?? {};
  return {
    mode: ['shadow', 'live', 'off'].includes(value.mode) ? value.mode : DEFAULT_RULE_CUE.mode,
    tau: Number.isFinite(value.tau) && value.tau >= 0 && value.tau <= 1 ? value.tau : DEFAULT_RULE_CUE.tau,
    delta: Number.isFinite(value.delta) && value.delta >= 0 && value.delta <= 1 ? value.delta : DEFAULT_RULE_CUE.delta,
    noveltyThreshold: Number.isFinite(value.noveltyThreshold) && value.noveltyThreshold > 0 && value.noveltyThreshold <= 1 ? value.noveltyThreshold : DEFAULT_RULE_CUE.noveltyThreshold,
    historyWindowMs: Number.isFinite(value.historyWindowMs) && value.historyWindowMs >= 0 ? value.historyWindowMs : DEFAULT_RULE_CUE.historyWindowMs,
    liveSessionIds: Array.isArray(value.liveSessionIds) ? [...new Set(value.liveSessionIds.filter(id => typeof id === 'string'))] : [],
    embeddingModel: typeof value.embeddingModel === 'string' ? value.embeddingModel : null,
  };
}

/** Remove transport metadata from the text embedded for Rule Cue only. */
export function stripRuleCueTransportEnvelope(text) {
  const value = String(text ?? '').trim();
  return value.replace(/^\[courier peer message from [^\]\r\n]+\]\s*/i, '').trim();
}

export function isRuleCueMessage(message) {
  const source = message?.source ?? message?.data?.source ?? null;
  return source?.kind === RULE_CUE_SOURCE;
}

/** The host may persist decision messages; pre-step retires the previous cue before adding another. */
export function ruleCueMessage(selected) {
  const rows = Array.isArray(selected) ? selected : [];
  const body = rows.map(hit => `[${hit.id}·${hit.section}]\n${hit.text}`).join('\n\n');
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: `[规则提示·相关条目]\n以下规则/习惯摘录与当前任务可能相关；只补充注意力，不替代全文，无关时忽略。\n\n${body}` }],
    source: { kind: RULE_CUE_SOURCE, ephemeral: true, ruleIds: rows.map(hit => hit.id) },
  };
}

export function retiredRuleCueMessage() {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: '' }],
    source: { kind: RULE_CUE_RETIRED_SOURCE },
  };
}

/** Parse one heading + one complete bullet/continuation block. */
export function parseRuleBlocks(text, prefix, sourcePath) {
  const lines = String(text ?? '').split(/\r?\n/);
  const blocks = [];
  let section = '';
  let sectionIndex = 0;
  let current = null;
  const finish = () => { if (current) blocks.push(current); current = null; };
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      finish();
      sectionIndex += 1;
      section = heading[1].replace(/[：:]\s*$/, '');
      continue;
    }
    if (/^##?\s/.test(line) || !section) continue;
    if (/^-\s+/.test(line)) {
      finish();
      const id = `${prefix}${sectionIndex}.${blocks.filter(block => block.section === section).length + 1}`;
      current = { id, section, sourcePath, text: line, vectorText: `${section}：${line}` };
    } else if (current && line.trim()) {
      current.text += `\n${line}`;
      current.vectorText += `\n${line}`;
    }
  }
  finish();
  return blocks;
}

export function ruleCueCosine(left, right) {
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

export function selectNovelRuleHits(hits, references = [], threshold = DEFAULT_RULE_CUE.noveltyThreshold) {
  const selected = [];
  const vectors = references.map(row => row.vector);
  for (const hit of [...hits].sort((left, right) => right.score - left.score)) {
    if (!Array.isArray(hit.vector) || !hit.vector.every(Number.isFinite)) continue;
    if (vectors.some(vector => ruleCueCosine(hit.vector, vector) >= threshold)) continue;
    selected.push(hit);
    vectors.push(hit.vector);
  }
  return selected;
}

export function scoreRuleBlocks(blocks, queryVector, config = DEFAULT_RULE_CUE) {
  const candidates = blocks.map(block => ({ ...block, score: ruleCueCosine(queryVector, block.vector) })).sort((a, b) => b.score - a.score);
  const top = candidates[0]?.score ?? 0;
  const threshold = Math.max(config.tau, top - config.delta);
  return { top, threshold, candidates: candidates.filter(row => row.score >= threshold) };
}

function historyFile(root) { return path.join(root, 'rule-cue-history.json'); }
function readHistory(root) {
  const file = historyFile(root);
  if (!fs.existsSync(file)) return [];
  try {
    const row = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(row?.entries) ? row.entries.filter(entry => typeof entry.ruleId === 'string' && Number.isFinite(entry.injectedAt)) : [];
  } catch { return []; }
}

export function recentRuleCueIds(root, now = Date.now(), windowMs = DEFAULT_RULE_CUE.historyWindowMs) {
  return new Set(readHistory(root).filter(entry => now - entry.injectedAt <= windowMs).map(entry => entry.ruleId));
}

export function markRuleCueHistory(root, ids, now = Date.now()) {
  const byId = new Map(readHistory(root).map(entry => [entry.ruleId, entry]));
  for (const id of ids) byId.set(id, { ruleId: id, injectedAt: now });
  const entries = [...byId.values()].sort((left, right) => left.injectedAt - right.injectedAt).slice(-500);
  fs.mkdirSync(root, { recursive: true });
  const file = historyFile(root);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ entries }, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

export function appendRuleCueLog(root, row) {
  try { fs.appendFileSync(path.join(root, 'rule-cue-log.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`, 'utf8'); }
  catch { /* shadow diagnostics never block delivery */ }
}
