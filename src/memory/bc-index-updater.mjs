/**
 * Incremental B-index updater.
 *
 * One pointer record per completed turn. The raw text stays in the session log;
 * this module only writes generic concepts, scores, keywords, and seq pointers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { embedTexts } from '../facets/embedding.mjs';
import { createBLabeler, LABELER_VERSION } from './bc-label.mjs';
import { extractKeywords, makeRecord } from './bc-recall.mjs';
import { loadIndexJsonl, saveIndexJsonl } from './bc-index.mjs';
import { loadSpecialKeywords, matchSpecialKeywords } from './special-keywords.mjs';
import { loadCMapEntries } from './cmap-file.mjs';
import { buildDf, chatterScore } from './chatter.mjs';
import { eventText } from '../session-log.mjs';

const INJECTED = /^\[(?:抽取|工作线|标签|规则|习惯|技能|归位|候选|存\?|闸|回正|学习|追忆|记忆|continuity:[a-z-]+)\]/;
const MACHINE = /^(?:Current runtime context|Current working directory|Current DSH file policy|Approval prompts|Time sampled)/;
const BASELINE_WINDOW = 300;
// 打标阈值：既喂给 labeler，也参与 labelStamp 的计算（改这里等于改依据）
export const TOPIC_THRESHOLDS = Object.freeze({ topicMinScore: 0.33, centerMin: 0.02, lead: 0.02 });

/**
 * labelStamp：这一行是"用哪套依据"标的。
 * stamp = sha256(concepts.md 内容 | 阈值 | LABELER_VERSION)[:12]
 * 表没变、阈值没变、判定逻辑没变 → stamp 不变 → 增量迁移时这行不需要重标。
 */
export function computeLabelStamp({ conceptsText = '', thresholds = TOPIC_THRESHOLDS, labelerVersion = LABELER_VERSION } = {}) {
  return createHash('sha256')
    .update(`${conceptsText}|${thresholds.topicMinScore}|${thresholds.centerMin}|${thresholds.lead}|${labelerVersion}`)
    .digest('hex')
    .slice(0, 12);
}

function emptyBaseline() {
  return { version: 2, window: BASELINE_WINDOW, topics: {}, workflows: {} };
}

function loadBaseline(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (parsed && parsed.version === 2 && parsed.topics && parsed.workflows) return parsed;
    if (parsed && parsed.version === 1 && parsed.samples && typeof parsed.samples === 'object') {
      return { version: 2, window: BASELINE_WINDOW, topics: parsed.samples, workflows: {} };
    }
  } catch { /* first run */ }
  return emptyBaseline();
}

function baselineMeans(state, group = 'topics') {
  const means = {};
  for (const [concept, samples] of Object.entries(state?.[group] ?? {})) {
    if (!Array.isArray(samples) || samples.length === 0) continue;
    means[concept] = samples.reduce((sum, value) => sum + Number(value || 0), 0) / samples.length;
  }
  return means;
}

function baselineGlobalMean(means) {
  const values = Object.values(means ?? {}).filter((value) => Number.isFinite(value));
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function updateBaseline(state, scores, group = 'topics') {
  if (!scores || typeof scores !== 'object') return state;
  if (!state[group] || typeof state[group] !== 'object') state[group] = {};
  for (const [concept, score] of Object.entries(scores)) {
    if (!Number.isFinite(Number(score))) continue;
    const samples = Array.isArray(state[group][concept]) ? state[group][concept] : [];
    samples.push(Number(score));
    if (samples.length > BASELINE_WINDOW) samples.shift();
    state[group][concept] = samples;
  }
  return state;
}

function saveBaseline(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(state), 'utf8');
    fs.renameSync(temp, file);
  } catch { /* baseline failure must not block indexing */ }
}

function isHuman(event) {
  const source = event?.data?.source ?? event?.source;
  if (source && typeof source.kind === 'string' && source.kind !== 'user') return false;
  if (source && source.peer === true) return false;
  const text = eventText(event, { includeReasoning: false }).trim();
  return Boolean(text) && !INJECTED.test(text) && !MACHINE.test(text);
}

function turnsFromEvents(events, afterTurn, afterSeq = -1) {
  const list = Array.isArray(events) ? events : [];
  const markers = list
    .map((event) => ({ seq: Number(event?.seq), turn: Number(event?.data?.turn) }))
    .filter((item) => Number.isInteger(item.seq) && Number.isInteger(item.turn))
    .sort((a, b) => a.seq - b.seq);
  const turnAt = (seq) => {
    let found = null;
    for (const marker of markers) {
      if (marker.seq > seq) break;
      found = marker.turn;
    }
    if (found !== null) return found;
    const next = markers.find((marker) => marker.seq >= seq);
    return next?.turn ?? null;
  };
  const byTurn = new Map();
  for (const event of list) {
    const type = event?.type;
    if (type !== 'user/message' && type !== 'assistant/message') continue;
    if (type === 'user/message' && !isHuman(event)) continue;
    const text = eventText(event, { includeReasoning: false }).trim();
    if (!text || INJECTED.test(text) || MACHINE.test(text)) continue;
    const seq = Number(event?.seq);
    const turn = Number.isInteger(Number(event?.data?.turn))
      ? Number(event.data.turn)
      : turnAt(seq);
    if (!Number.isInteger(turn) || !Number.isInteger(seq)) continue;
    if (turn <= afterTurn || seq <= afterSeq) continue;
    const item = byTurn.get(turn) ?? {
      turn,
      seqStart: seq,
      seqEnd: seq,
      userTexts: [],
      assistantTexts: [],
      texts: [],
    };
    item.seqStart = Math.min(item.seqStart, seq);
    item.seqEnd = Math.max(item.seqEnd, seq);
    if (type === 'user/message') item.userTexts.push(text);
    else item.assistantTexts.push(text);
    byTurn.set(turn, item);
  }
  return [...byTurn.values()]
    .map((item) => ({ ...item, texts: [...item.userTexts, ...item.assistantTexts] }))
    .sort((a, b) => a.turn - b.turn);
}

export function createIndexUpdater({
  file,
  stateFile = null,
  baselineFile = null,
  sessionQuery = null,
  labeler = null,
  labels = null,
  kinds = null,
  keywordsFile = null,
  cmapFile = null,
  conceptsFile = null,
  gate = null,
  maxPerRun = 8,
  onError = null,
  onCost = null,
} = {}) {
  let activeLabeler = labeler;
  let running = false;
  let warnedMissingCmap = false;
  // 保存的是 promise 而不是 bool：bool 在"刚结束但尚未置回"的窗口里不可靠
  let runningPromise = null;
  // gate 命中时被挡下的行留在这里，下一轮先合并再写（不丢数据）
  const pendingBySession = new Map();

  const readState = () => {
    if (stateFile === null) return {};
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; }
  };
  const writeState = (value) => {
    if (stateFile === null) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(value, null, 2), 'utf8');
    } catch { /* state failure must not block indexing */ }
  };
  const takePending = (sessionId) => {
    const rows = pendingBySession.get(sessionId) ?? [];
    pendingBySession.delete(sessionId);
    return rows;
  };
  const pushPending = (sessionId, rows) => {
    if (!rows || rows.length === 0) return;
    const existing = pendingBySession.get(sessionId) ?? [];
    const byTurn = new Map(existing.map((row) => [row.turn, row]));
    for (const row of rows) byTurn.set(row.turn, row);
    pendingBySession.set(sessionId, [...byTurn.values()]);
  };

  const runOnce = async ({ agent = null, lastTurn = null } = {}) => {
    const started = performance.now();
    try {
      const sessionId = agent?.session?.id;
      if (sessionId === undefined || sessionId === null) return { added: 0, skipped: 'no-session-id' };
      // labelStamp：本 session 的 concepts.md 内容 + 阈值 + LABELER_VERSION。
      // 拿不到 concepts.md 就不写 stamp（宁缺勿假，后续迁移会补）。
      const conceptsText = conceptsFile && fs.existsSync(conceptsFile)
        ? fs.readFileSync(conceptsFile, 'utf8')
        : '';
      const labelStamp = conceptsText ? computeLabelStamp({ conceptsText }) : null;
      const records = loadIndexJsonl(file);
      const maxTurn = records.reduce((max, record) => Number.isInteger(record.turn) ? Math.max(max, record.turn) : max, -1);
      const maxSeq = records.reduce((max, record) => Number.isInteger(record.seqEnd) ? Math.max(max, record.seqEnd) : max, -1);
      const state = readState();
      const afterSeq = Number.isInteger(state.lastSeq) ? Math.max(maxSeq, state.lastSeq) : maxSeq;

      let readMs = 0;
      const readStarted = performance.now();
      let events;
      let mode = 'full';
      if (typeof sessionQuery.readSessionTail === 'function') {
        const snapshot = await sessionQuery.readSessionTail(sessionId, { afterSeq, limit: 512 });
        events = snapshot?.events ?? [];
        mode = 'tail';
      } else {
        const snapshot = await sessionQuery.readSession(sessionId, { afterSeq, limit: 512 });
        events = snapshot?.events ?? [];
        mode = events.length > 0 && events.every((event) => Number(event?.seq) > afterSeq) ? 'tail' : 'full';
      }
      readMs = Math.round(performance.now() - readStarted);

      const missing = turnsFromEvents(events, maxTurn, afterSeq)
        .filter((entry) => !Number.isInteger(lastTurn) || entry.turn < lastTurn);
      const turns = missing.slice(0, maxPerRun);
      const remaining = Math.max(0, missing.length - turns.length);
      if (turns.length === 0) return { added: 0, maxTurn, remaining: 0, mode, readMs, totalMs: Math.round(performance.now() - started) };

      const resolvedBaselineFile = baselineFile ?? path.join(path.dirname(file), 'bc-topic-baseline.json');
      const baseline = loadBaseline(resolvedBaselineFile);
      const topicMeans = baselineMeans(baseline, 'topics');
      const topicFallback = baselineGlobalMean(topicMeans);
      const workflowMeans = baselineMeans(baseline, 'workflows');
      const workflowFallback = baselineGlobalMean(workflowMeans);

      if (activeLabeler === null) activeLabeler = createBLabeler({
        embed: embedTexts,
        ...(labels ? { labels, concepts: Object.keys(labels) } : {}),
        ...(kinds ? { kinds } : {}),
      });
      const specialKeywords = keywordsFile && !fs.existsSync(keywordsFile)
        ? []
        : loadSpecialKeywords(keywordsFile ?? undefined);
      const cmapTerms = cmapFile === null
        ? []
        : loadCMapEntries(cmapFile)
          .map((entry) => entry.term)
          .filter((term) => typeof term === 'string' && term.length > 0);
      if (cmapFile === null && !warnedMissingCmap) {
        warnedMissingCmap = true;
        const error = new Error('cmapFile not provided; C terms skipped');
        error.code = 'cmap-file-missing';
        onError?.(error);
      }
      const df = buildDf([
        ...records.map((record) => (record.keywords ?? []).join(' ')),
        ...turns.map((entry) => entry.texts.join('\n')),
      ]);
      const added = [];
      const labelStarted = performance.now();
      for (const entry of turns) {
        const text = entry.texts.join('\n');
        const labelOptions = {
          topK: 3,
          minScore: 0.25,
          topicMinScore: 0.33,
          topicCenterMin: 0.02,
          topicLead: 0.02,
          topicTopK: 1,
          workflowTopK: 2,
          workflowCenterMin: 0.02,
          workflowLead: 0.02,
          topicBaseline: topicMeans,
          topicBaselineFallback: topicFallback,
          workflowBaseline: workflowMeans,
          workflowBaselineFallback: workflowFallback,
          chunkChars: 600,
          maxChunks: 12,
        };
        const label = typeof activeLabeler.labelChunked === 'function'
          ? await activeLabeler.labelChunked(text, labelOptions)
          : await activeLabeler.label(text, labelOptions);
        updateBaseline(baseline, label.topicScores, 'topics');
        updateBaseline(baseline, label.workflowScores, 'workflows');
        const isV2 = label.version === 2;
        const generic = label.candidates.map((candidate) => candidate.concept);
        const conceptScores = Object.fromEntries(
          (label.scores ? Object.entries(label.scores) : label.candidates.map((candidate) => [candidate.concept, candidate.score])),
        );
        const genericTopic = isV2 ? (label.topic ?? []).map((candidate) => candidate.concept) : undefined;
        const genericWorkflow = isV2 ? (label.workflow ?? []).map((candidate) => candidate.concept) : undefined;
        const keywords = [...new Set([
          ...extractKeywords(text, { limit: 12 }),
          ...matchSpecialKeywords(text, specialKeywords),
        ])];
        const terms = [...new Set(cmapTerms.filter((term) => text.includes(term) || keywords.includes(term)))];
        added.push(makeRecord({
          turn: entry.turn,
          seqStart: entry.seqStart,
          seqEnd: entry.seqEnd,
          text,
          generic,
          ...(isV2 ? {
            genericTopic,
            genericWorkflow,
            topicScore: label.topicScore,
            topicConfidence: label.topicConfidence,
            topicMinScore: label.topicMinScore,
          } : {}),
          labelVersion: isV2 ? 2 : 1,
          ...(labelStamp ? { labelStamp } : {}),
          terms,
          keywords,
          conceptScores,
          confidence: label.top?.score ?? 0,
          status: 'weak',
          ...(Array.isArray(label.vector) ? { vec: Buffer.from(Float32Array.from(label.vector).buffer).toString('base64') } : {}),
          chatter: chatterScore(text, df),
          sessionId,
        }));
      }
      const labelMs = Math.round(performance.now() - labelStarted);
      // 先把上一轮被 gate 挡下的行并回来（按 turn 去重），再决定这次能不能写
      const carried = takePending(sessionId);
      if (carried.length > 0) {
        const byTurn = new Map(carried.map((row) => [row.turn, row]));
        for (const row of added) byTurn.set(row.turn, row);
        added.splice(0, added.length, ...[...byTurn.values()].sort((a, b) => Number(a.turn) - Number(b.turn)));
      }
      // 互斥 B：正在迁移期间不写盘，且**不推进 state / 不写 baseline**
      // 被挡的行进 pendingBySession，下一轮先合并再写——否则这些轮次会永久丢失
      if (gate && typeof gate.isBlocked === 'function' && gate.isBlocked(sessionId)) {
        pushPending(sessionId, added);
        return {
          added: 0,
          skipped: 'relabel',
          blocked: true,
          pending: (pendingBySession.get(sessionId) ?? []).length,
          maxTurn,
        };
      }
      const writeStarted = performance.now();
      saveIndexJsonl(file, [...records, ...added]);
      saveBaseline(resolvedBaselineFile, baseline);
      const writeMs = Math.round(performance.now() - writeStarted);
      const lastSeq = added.at(-1)?.seqEnd ?? afterSeq;
      const lastTurnWritten = added.at(-1)?.turn ?? maxTurn;
      writeState({ at: new Date().toISOString(), lastSeq, lastTurn: lastTurnWritten, maxTurn: lastTurnWritten });
      const cost = {
        at: new Date().toISOString(),
        added: added.length,
        ms: Math.round(performance.now() - started),
        readMs,
        labelMs,
        writeMs,
        totalMs: Math.round(performance.now() - started),
        maxTurn: lastTurnWritten,
        maxSeq: lastSeq,
        remaining,
        mode,
      };
      try { onCost?.(cost); } catch { /* ignore */ }
      return { ...cost, records: added };
    } catch (error) {
      try {
        onError?.(error);
      } catch { /* ignore */ }
      return { added: 0, error: String(error?.message ?? error) };
    }
  };

  const updateIndex = async (payload = {}) => {
    if (!sessionQuery || typeof sessionQuery.readSession !== 'function') return { added: 0, skipped: 'no-session' };
    if (runningPromise) return { added: 0, skipped: 'busy' };
    running = true;
    runningPromise = runOnce(payload).finally(() => {
      running = false;
      runningPromise = null;
    });
    return runningPromise;
  };

  /** 等当前这一次写盘结束（迁移开始前必须 await）。 */
  updateIndex.whenIdle = () => runningPromise ?? Promise.resolve();
  /** 是否正有一次写盘在跑。 */
  updateIndex.isRunning = () => runningPromise !== null;
  /** 被 gate 挡下的行数（观测用）。 */
  updateIndex.pendingCount = (sessionId) => (pendingBySession.get(sessionId) ?? []).length;

  return updateIndex;
}

export function defaultCostLogPath(home = process.env.USERPROFILE ?? process.env.HOME ?? '') {
  return path.join(home, '.dsh', 'continuity', 'bc-index-cost.jsonl');
}

export function appendCostLog(file, cost) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(cost) + '\n', 'utf8');
  } catch { /* cost log must not break indexing */ }
}
