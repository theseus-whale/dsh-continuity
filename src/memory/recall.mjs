/**
 * Lexical recall over the immutable session event log.
 *
 * This is deliberately small: it only answers "which previous turn/seq
 * contains text close to this query". It does not call the LLM and it does
 * not write anything.
 */
import { eventText } from '../session-log.mjs';
import { BM25Index } from './bm25.mjs';
import { tokenize } from './tokenize.mjs';

const INJECTED_PREFIXES = ['[continuity:', '[抽取]', '[工作线]', '[标签]', '[规矩]', '[习惯]', '[技能]', '[归位', '[候选', '[存?]', '[闸', '[gate', '[peer', '[回正]', '[学习', '[话题?]'];

function isInjected(text) {
  return INJECTED_PREFIXES.some((prefix) => text.startsWith(prefix));
}

export function collectRecallRecords(events = [], { beforeTurn = Infinity } = {}) {
  const records = [];
  for (const event of events) {
    if (event?.type !== 'user/message') continue;
    const text = eventText(event).trim();
    if (text.length === 0 || isInjected(text)) continue;
    const turn = Number(event?.data?.turn ?? event?.turn);
    if (Number.isFinite(turn) && turn >= beforeTurn) continue;
    const seq = Number(event?.seq);
    if (!Number.isInteger(seq)) continue;
    records.push({
      turn: Number.isFinite(turn) ? turn : null,
      seqStart: seq,
      seqEnd: seq,
      text,
    });
  }
  return records;
}

export function buildRecallIndex(events, options = {}) {
  const records = collectRecallRecords(events, options);
  return { records, index: new BM25Index().build(records) };
}

export function findRecall(recall, query, { topK = 3, minCoverage = 0.3 } = {}) {
  if (!recall || !Array.isArray(recall.records) || recall.records.length === 0) return [];
  const hits = recall.index.search(String(query ?? ''), { topK, minCoverage });
  return hits.map((hit) => ({
    turn: hit.turn,
    seqStart: hit.seqStart,
    seqEnd: hit.seqEnd,
    score: hit.score,
    coverage: hit.coverage,
    text: recall.records.find((record) => record.seqStart === hit.seqStart)?.text ?? '',
  }));
}

export function renderRecall(hit, query = '') {
  const where = hit.turn === null ? `seq ${hit.seqStart}` : `turn ${hit.turn} / seq ${hit.seqStart}`;
  const lower = String(hit.text ?? '').toLowerCase();
  const terms = [...new Set(tokenize(query))]
    .filter((term) => term.length >= 2 && lower.includes(term.toLowerCase()))
    .slice(0, 4);
  const label = terms.length > 0 ? terms.join(' / ') : '旧记录';
  const snippet = String(hit.text ?? '').replace(/\s+/g, ' ').slice(0, 80);
  return `[追忆] ${label} -> ${where}\n${snippet}`;
}
