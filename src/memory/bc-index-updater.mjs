/**
 * Incremental B-index updater.
 *
 * One pointer record per completed turn. The raw text stays in the session log;
 * this module only writes generic concepts, scores, keywords, and seq pointers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { embedTexts } from '../facets/embedding.mjs';
import { createBLabeler } from './bc-label.mjs';
import { extractKeywords, makeRecord } from './bc-recall.mjs';
import { loadIndexJsonl, saveIndexJsonl } from './bc-index.mjs';
import { loadSpecialKeywords, matchSpecialKeywords } from './special-keywords.mjs';
import { buildDf, chatterScore } from './chatter.mjs';
import { eventText } from '../session-log.mjs';

const INJECTED = /^\[(?:抽取|工作线|标签|规则|习惯|技能|归位|候选|存\?|闸|回正|学习|追忆|记忆|continuity:[a-z-]+)\]/;
const MACHINE = /^(?:Current runtime context|Current working directory|Current DSH file policy|Approval prompts|Time sampled)/;

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
  sessionQuery = null,
  labeler = null,
  labels = null,
  kinds = null,
  keywordsFile = null,
  maxPerRun = 8,
  onError = null,
  onCost = null,
} = {}) {
  let activeLabeler = labeler;
  let running = false;

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

  return async function updateIndex({ agent = null, lastTurn = null } = {}) {
    if (running || !sessionQuery || typeof sessionQuery.readSession !== 'function') return { added: 0, skipped: 'no-session' };
    running = true;
    const started = performance.now();
    try {
      const sessionId = agent?.session?.id;
      if (sessionId === undefined || sessionId === null) return { added: 0, skipped: 'no-session-id' };
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

      if (activeLabeler === null) activeLabeler = createBLabeler({
        embed: embedTexts,
        ...(labels ? { labels, concepts: Object.keys(labels) } : {}),
        ...(kinds ? { kinds } : {}),
      });
      const specialKeywords = keywordsFile && !fs.existsSync(keywordsFile)
        ? []
        : loadSpecialKeywords(keywordsFile ?? undefined);
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
          topicMargin: 0.03,
          topicTopK: 1,
          chunkChars: 600,
          maxChunks: 12,
        };
        const label = typeof activeLabeler.labelChunked === 'function'
          ? await activeLabeler.labelChunked(text, labelOptions)
          : await activeLabeler.label(text, labelOptions);
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
      const writeStarted = performance.now();
      saveIndexJsonl(file, [...records, ...added]);
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
    } finally {
      running = false;
    }
  };
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
