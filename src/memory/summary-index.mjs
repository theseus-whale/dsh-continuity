/**
 * Summary index for Continuity.
 *
 * This is the middle layer between gist pointers and raw session text:
 *   gist        short pointer (existing)
 *   summary     structured text over a seq range (this index)
 *   raw         session log, source of truth
 *
 * Phase 0/1 is read-only/index-only: it imports existing compaction/summary
 * events (native checkpoints and Continuity gists) and plans missing windows.
 * It never rewrites or deletes raw events.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const SUMMARY_INDEX_VERSION = 1;
export const DEFAULT_WINDOW_TOKENS = 40_000;

const GIST_PREFIX = /^\[(?:thread|gist)\b/i;

function numberOrNull(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

export function summaryText(event) {
  const summary = event?.data?.summary;
  if (Array.isArray(summary)) {
    return summary
      .map((block) => (block && typeof block === 'object' && typeof block.text === 'string' ? block.text : ''))
      .join('');
  }
  return typeof summary === 'string' ? summary : '';
}

function turnMarkers(events) {
  return (Array.isArray(events) ? events : [])
    .filter((event) => event?.type === 'turn/start' && Number.isInteger(Number(event?.data?.turn)))
    .map((event) => ({ seq: Number(event.seq), turn: Number(event.data.turn) }))
    .sort((a, b) => a.seq - b.seq);
}

function turnAt(markers, seq) {
  let found = null;
  for (const marker of markers) {
    if (marker.seq <= seq) found = marker.turn;
    else break;
  }
  return found;
}

function textTokens(text) {
  return Math.max(1, Math.ceil(String(text ?? '').length / 4));
}

function parseThreads(text) {
  const out = new Set();
  const pattern = /\b(?:T|thread)=([A-Za-z0-9_-]+)/g;
  let match;
  while ((match = pattern.exec(String(text ?? ''))) !== null) out.add(match[1]);
  return [...out];
}

function recordFromEvent(event, markers) {
  const text = summaryText(event).trim();
  if (!text) return null;
  const start = numberOrNull(event?.data?.shadowedRange?.start);
  const end = numberOrNull(event?.data?.shadowedRange?.end);
  if (start === null || end === null) return null;
  const fromSeq = Math.min(start, end);
  const toSeq = Math.max(start, end);
  const kind = GIST_PREFIX.test(text) ? 'gist' : 'checkpoint';
  return {
    id: `s-${fromSeq}-${toSeq}`,
    kind,
    fromSeq,
    toSeq,
    fromTurn: turnAt(markers, fromSeq),
    toTurn: turnAt(markers, toSeq),
    threads: parseThreads(text),
    chars: text.length,
    approxTokens: textTokens(text),
    sourceTokens: numberOrNull(event?.data?.shadowedTokenCount),
    sourceHash: createHash('sha256').update(`${fromSeq}:${toSeq}:${text}`, 'utf8').digest('hex'),
    text,
    status: 'ready',
  };
}

function mergeRanges(records) {
  const ranges = records
    .map((record) => ({ start: record.fromSeq, end: record.toSeq }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function visibleText(event) {
  if (!event || (event.type !== 'user/message' && event.type !== 'assistant/message')) return '';
  const content = event.type === 'assistant/message'
    ? event?.data?.message?.content
    : event?.data?.content;
  let out = '';
  for (const block of content ?? []) {
    if (block && block.type === 'text') out += block.text ?? '';
  }
  return out;
}

function estimateGapTokens(events, start, end) {
  let tokens = 0;
  for (const event of events) {
    const seq = Number(event?.seq);
    if (!Number.isInteger(seq) || seq < start || seq > end) continue;
    tokens += textTokens(visibleText(event));
  }
  return tokens;
}

/**
 * Build a summary index from one session's raw events.
 * @param {{sessionId: string, events: object[], windowTokens?: number}} input
 */
export function buildSummaryIndex({
  sessionId,
  events,
  windowTokens = DEFAULT_WINDOW_TOKENS,
  bootstrapRanges = [],
  windowRanges = [],
  windowRecords = [],
}) {
  const list = Array.isArray(events) ? events : [];
  const markers = turnMarkers(list);
  const records = list
    .filter((event) => event?.type === 'compaction/summary')
    .map((event) => recordFromEvent(event, markers))
    .filter(Boolean)
    .sort((a, b) => a.fromSeq - b.fromSeq || a.toSeq - b.toSeq);
  const unique = [];
  const seen = new Set();
  for (const record of records) {
    const key = `${record.fromSeq}:${record.toSeq}:${record.sourceHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(record);
  }
  const boot = (Array.isArray(bootstrapRanges) ? bootstrapRanges : [])
    .map((range) => ({
      fromSeq: Number(range?.fromSeq ?? range?.start),
      toSeq: Number(range?.toSeq ?? range?.end),
      tokens: Number(range?.tokens ?? 0),
      carrierSeq: Number(range?.carrierSeq ?? 0),
      at: typeof range?.at === 'string' ? range.at : null,
      kind: 'bootstrap-replace',
    }))
    .filter((range) => Number.isInteger(range.fromSeq) && Number.isInteger(range.toSeq))
    .map((range) => (range.fromSeq <= range.toSeq ? range : { ...range, fromSeq: range.toSeq, toSeq: range.fromSeq }))
    .sort((a, b) => a.fromSeq - b.fromSeq || a.toSeq - b.toSeq);
  const windows = (Array.isArray(windowRanges) ? windowRanges : [])
    .map((range) => ({
      fromSeq: Number(range?.fromSeq ?? range?.start),
      toSeq: Number(range?.toSeq ?? range?.end),
      tokens: Number(range?.tokens ?? 0),
      hash: typeof range?.hash === 'string' ? range.hash : null,
      at: typeof range?.at === 'string' ? range.at : null,
      kind: 'window-extractive',
    }))
    .filter((range) => Number.isInteger(range.fromSeq) && Number.isInteger(range.toSeq))
    .map((range) => (range.fromSeq <= range.toSeq ? range : { ...range, fromSeq: range.toSeq, toSeq: range.fromSeq }))
    .sort((a, b) => a.fromSeq - b.fromSeq || a.toSeq - b.toSeq);
  const windowRecordList = (Array.isArray(windowRecords) ? windowRecords : [])
    .map((summary) => ({
      id: `window-${Number(summary?.fromSeq)}-${Number(summary?.toSeq)}`,
      kind: 'window-extractive',
      quality: 'extractive',
      fromSeq: Number(summary?.fromSeq),
      toSeq: Number(summary?.toSeq),
      text: String(summary?.text ?? ''),
      sourceHash: String(summary?.hash ?? ''),
      sourceTokens: Number(summary?.approxTokens ?? 0),
      fromTurn: null,
      toTurn: null,
    }))
    .filter((record) => Number.isInteger(record.fromSeq) && Number.isInteger(record.toSeq) && record.text.length > 0);

  const seqs = list.map((event) => Number(event?.seq)).filter(Number.isInteger);
  const minSeq = seqs.length ? Math.min(...seqs) : null;
  const maxSeq = seqs.length ? Math.max(...seqs) : null;
  const ranges = mergeRanges([...unique, ...boot, ...windows]);
  const gaps = [];
  if (minSeq !== null && maxSeq !== null) {
    let cursor = minSeq;
    for (const range of ranges) {
      if (range.start > cursor) gaps.push({ start: cursor, end: range.start - 1 });
      cursor = Math.max(cursor, range.end + 1);
    }
    if (cursor <= maxSeq) gaps.push({ start: cursor, end: maxSeq });
  }
  const pendingWindows = gaps
    .map((gap) => ({
      ...gap,
      approxTokens: estimateGapTokens(list, gap.start, gap.end),
    }))
    .filter((gap) => gap.approxTokens >= windowTokens)
    .map((gap) => ({
      id: `pending-${gap.start}-${gap.end}`,
      fromSeq: gap.start,
      toSeq: gap.end,
      approxTokens: gap.approxTokens,
      status: 'missing',
    }));

  const sourceTokens = ranges.reduce((sum, range) => sum + estimateGapTokens(list, range.start, range.end), 0);
  const summaryEvents = list.filter((event) => event?.type === 'compaction/summary');
  const maxSummarySeq = summaryEvents.reduce((max, event) => {
    const seq = Number(event?.seq);
    return Number.isInteger(seq) && seq > max ? seq : max;
  }, -1);
  const coveredThroughSeq = [...unique, ...boot, ...windows].reduce((max, record) => (record.toSeq > max ? record.toSeq : max), -1);
  const latestSummaryAt = summaryEvents.reduce((latest, event) => {
    const time = Number(event?.time);
    return Number.isFinite(time) && time > latest ? time : latest;
  }, 0);
  return {
    version: SUMMARY_INDEX_VERSION,
    sessionId: String(sessionId ?? ''),
    generatedAt: new Date().toISOString(),
    windowTokens,
    maxSummarySeq,
    coveredThroughSeq,
    latestSummaryAt: latestSummaryAt > 0 ? new Date(latestSummaryAt).toISOString() : null,
    records: [...unique, ...windowRecordList],
    bootstrapRanges: boot,
    windowRanges: windows,
    pendingWindows,
    coverage: {
      minSeq,
      maxSeq,
      records: unique.length,
      modelRecords: unique.length,
      ready: unique.length,
      windows: windows.length,
      pending: pendingWindows.length,
      bootstrap: boot.length,
      ranges: ranges.length,
      sourceTokensBasis: 'dedup-merged-ranges',
      sourceTokens,
      sourceTokensSum: unique.reduce((sum, record) => sum + (record.sourceTokens ?? 0), 0),
    },
  };
}

export function summaryIndexPath(sessionDir) {
  return path.join(sessionDir, 'summaries', 'index.json');
}

/** Compare the summary index against the newest live summary event. */
export function summaryIndexStaleness(index, records, { latestSummarySeq = null } = {}) {
  const fallbackSeq = (Array.isArray(records) ? records : [])
    .map((record) => Number(record?.seqEnd ?? record?.seq))
    .filter(Number.isInteger)
    .reduce((max, seq) => (seq > max ? seq : max), -1);
  const latestSeq = Number.isInteger(latestSummarySeq) ? latestSummarySeq : fallbackSeq;
  const rawMax = Number(index?.maxSummarySeq);
  const hasMax = Number.isInteger(rawMax) && rawMax >= 0;
  const maxSummarySeq = hasMax ? rawMax : null;
  const stale = !hasMax || !Number.isInteger(latestSeq) || latestSeq !== maxSummarySeq;
  const staleBy = hasMax && Number.isInteger(latestSeq) ? latestSeq - maxSummarySeq : null;
  return {
    stale,
    staleBy,
    latestSeq,
    maxSummarySeq,
    latestSummaryAt: index?.latestSummaryAt ?? null,
  };
}

/** Local, read-only summary lookup. This is the seed for recall.summaryHits. */
export function querySummaryIndex(index, query, { limit = 5 } = {}) {
  const q = String(query ?? '').normalize('NFKC').toLowerCase();
  if (!q) return { total: 0, hits: [] };
  const qChars = [...q];
  const cjkQuery = /[\u3400-\u9fff]/.test(q);
  const records = Array.isArray(index?.records) ? index.records : [];
  const scored = [];
  for (const record of records) {
    const text = String(record.text ?? '').normalize('NFKC').toLowerCase();
    if (!text) continue;
    let score = 0;
    const exact = text.includes(q);
    if (exact) score += 100;
    if (cjkQuery && qChars.length >= 2) {
      const covered = qChars.filter((ch) => text.includes(ch)).length;
      if (covered === qChars.length) score += 5;
    }
    if (score > 0) scored.push({ record, score, exact });
  }
  scored.sort((a, b) => b.score - a.score || b.record.toSeq - a.record.toSeq);
  return {
    total: scored.length,
    hits: scored.slice(0, limit).map(({ record, score, exact }) => ({
      id: record.id,
      kind: record.kind,
      quality: record.quality ?? null,
      fromSeq: record.fromSeq,
      toSeq: record.toSeq,
      fromTurn: record.fromTurn,
      toTurn: record.toTurn,
      threads: record.threads,
      approxTokens: record.approxTokens,
      score: Number(score.toFixed(2)),
      exact,
      excerpt: String(record.text ?? '').slice(0, 500),
    })),
  };
}

export function writeSummaryIndex(sessionDir, index) {
  const file = summaryIndexPath(sessionDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

export function readSummaryIndex(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}
