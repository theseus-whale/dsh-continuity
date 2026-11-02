/**
 * Historical backfill: select content events from the raw session snapshot,
 * trim incomplete tool pairs at the edges, and build an archival segment.
 * It never touches the live surface.
 */
import { estimateTextTokens, quoteEventText } from './threads.mjs';

export const BACKFILL_TYPES = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result']);

export function selectBackfillEvents(events, fromSeq, toSeq) {
  const bySeq = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (!BACKFILL_TYPES.has(event?.type)) continue;
    const seq = Number(event?.seq);
    if (!Number.isInteger(seq) || seq < fromSeq || seq > toSeq) continue;
    bySeq.set(seq, event);
  }
  return [...bySeq.values()].sort((left, right) => Number(left.seq) - Number(right.seq));
}

/** Drop a leading result or a trailing call; the live hole boundaries are complete. */
export function trimBackfillEvents(events) {
  const list = Array.isArray(events) ? [...events] : [];
  while (list.length > 0 && list[0]?.type === 'tool/result') list.shift();
  while (list.length > 0 && list[list.length - 1]?.type === 'tool/call') list.pop();
  return list;
}

export function buildBackfillSegment(events, {
  sessionId,
  why,
  next,
  residue,
  tCoverage = 'T0',
  now = new Date().toISOString(),
} = {}) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const fromSeq = Number(events[0].seq);
  const toSeq = Number(events[events.length - 1].seq);
  let tokens = 0;
  for (const event of events) tokens += estimateTextTokens(quoteEventText(event));
  const firstTime = Number(events[0]?.time);
  const lastTime = Number(events[events.length - 1]?.time);
  const spanStart = Number.isFinite(firstTime) ? new Date(firstTime).toISOString() : now;
  const spanEnd = Number.isFinite(lastTime) ? new Date(lastTime).toISOString() : spanStart;
  return {
    fromSeq,
    toSeq,
    seqs: events.map((event) => Number(event.seq)),
    count: events.length,
    spanStart,
    spanEnd,
    minutes: Math.max(0, Number(((Date.parse(spanEnd) - Date.parse(spanStart)) / 60000).toFixed(1))),
    tokens,
    why,
    next,
    ...(residue === undefined ? {} : { residue }),
    // `at` is content recency (when the conversation happened), not when the
    // backfill was written. Keep the insertion clock separately.
    at: spanEnd,
    archivedAt: now,
    archiveRef: `log:${sessionId}#seq=${fromSeq}-${toSeq}`,
    tCoverage,
  };
}

export function rangeOverlaps(existing, fromSeq, toSeq) {
  return (Array.isArray(existing) ? existing : []).some((segment) => {
    const a = Number(segment?.fromSeq);
    const b = Number(segment?.toSeq);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return fromSeq <= b && toSeq >= a;
  });
}
