import { sha256 } from './config.mjs';

export function foldId(fold) {
  return String(fold?.compactionId ?? fold?.foldId ?? `${fold?.from}-${fold?.to}`);
}

export function turnKey(sessionId, turn) {
  return `${sessionId}:${turn.seqStart}:${turn.seqEnd}:${turn.rawTextSha256}`;
}

/**
 * Pure fold -> complete turn mapping. No writes and no inference.
 * A turn is complete only when all its boundary seqs are shadowed.
 */
export function mapFoldToTurns({ sessionId, fold, turns, writtenKeys = new Set(), surfaceSeqs = null, eventsBySeq = null }) {
  if (!fold || !Array.isArray(fold.shadowedSeqs) || fold.shadowedSeqs.length === 0) {
    return { foldId: foldId(fold), candidates: [], partialHOLD: [], missing: [], outside: [], skipped: [], residual: [] };
  }
  const to = Number.isInteger(fold.to) ? fold.to : Math.max(...fold.shadowedSeqs);
  const shadowed = new Set(fold.shadowedSeqs.map(Number));
  const fullSurface = Array.isArray(surfaceSeqs) ? surfaceSeqs.map(Number) : null;
  const candidates = [];
  const partialHOLD = [];
  const missing = [];
  const outside = [];
  const skipped = [];
  const residual = [];
  const cache = new Map();
  const projection = (seq) => {
    const event = eventsBySeq?.get(seq);
    if (event?.type !== 'user/message') return false;
    const kind = event?.data?.message?.source?.kind ?? event?.data?.source?.kind ?? null;
    return !['user', 'peer'].includes(kind);
  };
  const turnFor = (seq) => {
    if (cache.has(seq)) return cache.get(seq);
    const turn = turns.find((candidate) => seq >= (candidate.hostStart ?? candidate.seqStart) && seq <= (candidate.hostEnd ?? candidate.seqEnd)) ?? null;
    cache.set(seq, turn);
    return turn;
  };
  const grouped = new Map();
  for (const seq of shadowed) {
    // Surface order is positional, not numeric: a newer checkpoint can replace
    // an older range. The selected slice itself is authoritative, not from/to.
    if (!Number.isInteger(seq)) { outside.push(seq); continue; }
    if (projection(seq)) { residual.push(seq); continue; }
    const turn = turnFor(seq);
    if (!turn) { missing.push(seq); continue; }
    const item = grouped.get(turn.turnId) ?? { turn, seqs: [] };
    item.seqs.push(seq);
    grouped.set(turn.turnId, item);
  }
  for (const { turn, seqs } of grouped.values()) {
    const boundaries = Array.isArray(turn.boundarySeqs) && turn.boundarySeqs.length > 0
      ? turn.boundarySeqs
      : [turn.seqStart, turn.seqEnd];
    const remainingSeqs = fullSurface === null ? [] : fullSurface.filter((seq) => !shadowed.has(seq) && !projection(seq) && turnFor(seq)?.turnId === turn.turnId);
    const complete = turn.closed !== false && (fullSurface === null
      ? boundaries.every((seq) => shadowed.has(seq))
      : remainingSeqs.length === 0);
    const key = turnKey(sessionId, turn);
    if (!complete) { partialHOLD.push({ turnId: turn.turnId, shadowedSeqs: seqs.sort((a, b) => a - b), remainingSeqs, boundarySeqs: boundaries }); continue; }
    if (writtenKeys.has(key)) { skipped.push({ ...turn, idempotencyKey: key }); continue; }
    candidates.push({ ...turn, idempotencyKey: key, firstFoldSeq: fold.gistSeq ?? fold.cutoff ?? to, availableCutoff: fold.cutoff ?? to });
  }
  return { foldId: foldId(fold), candidates, partialHOLD, missing, outside, skipped, residual };
}
