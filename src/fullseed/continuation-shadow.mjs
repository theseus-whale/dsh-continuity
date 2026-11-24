import { tokenize } from '../memory/tokenize.mjs';

/** Experimental, read-only diagnostics for directed thematic continuation. */
export function compareChronological(left, right) {
  return Number(left.seqStart) - Number(right.seqStart)
    || Number(left.seqEnd) - Number(right.seqEnd)
    || String(left.turnId ?? '').localeCompare(String(right.turnId ?? ''))
    || Number(left.chunkIndex ?? 0) - Number(right.chunkIndex ?? 0)
    || String(left.chunkId).localeCompare(String(right.chunkId));
}

export function buildChunkTimeline(summaries, vectors) {
  if (summaries.length !== vectors.length) throw new Error('summary/vector count mismatch');
  const timeline = summaries.map((summary, index) => {
    const vector = vectors[index];
    if (!Array.isArray(vector) || vector.length === 0 || !vector.every(Number.isFinite)) {
      throw new Error(`invalid vector for ${summary.chunkId}`);
    }
    return { ...summary, vector };
  }).sort(compareChronological);
  const ids = new Set(timeline.map((chunk) => chunk.chunkId));
  if (ids.size !== timeline.length) throw new Error('duplicate active chunkId');
  return timeline;
}

export function resolveAnchor(timeline, { chunkId, seqStart, seqEnd, chunkIndex } = {}) {
  const matches = timeline.filter((chunk) => (chunkId === undefined || chunk.chunkId === chunkId)
    && (seqStart === undefined || chunk.seqStart === Number(seqStart))
    && (seqEnd === undefined || chunk.seqEnd === Number(seqEnd))
    && (chunkIndex === undefined || chunk.chunkIndex === Number(chunkIndex)));
  if (matches.length === 0) throw new Error('anchor not found in active index');
  if (matches.length > 1) {
    const choices = matches.map((chunk) => `${chunk.chunkId}#${chunk.chunkIndex ?? 0}`).join(', ');
    throw new Error(`anchor is ambiguous; supply --chunk-id or --chunk-index: ${choices}`);
  }
  return matches[0];
}

export function cosineSimilarity(left, right) {
  if (left.length !== right.length) throw new Error('vector dimensions differ');
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function overlap(leftValues, rightValues) {
  const left = new Set(leftValues);
  const right = new Set(rightValues);
  const matched = [...left].filter((value) => right.has(value)).sort();
  return {
    matched,
    anchorCoverage: left.size ? matched.length / left.size : 0,
    candidateCoverage: right.size ? matched.length / right.size : 0,
    dice: left.size + right.size ? (2 * matched.length) / (left.size + right.size) : 0,
  };
}

export function lexicalOverlap(anchor, candidate) {
  return overlap(tokenize(anchor.summaryText), tokenize(candidate.summaryText));
}

export function entityOverlap(anchor, candidate) {
  const nouns = (chunk) => (chunk.concreteNouns ?? []).map((value) => String(value).trim().toLowerCase()).filter(Boolean);
  return overlap(nouns(anchor), nouns(candidate));
}

export function scorePair(anchor, candidate, direction = 'next') {
  if (direction !== 'next' && direction !== 'prev') throw new Error('direction must be next or prev');
  return {
    chunkId: candidate.chunkId,
    turnId: candidate.turnId,
    chunkIndex: candidate.chunkIndex,
    seqStart: candidate.seqStart,
    seqEnd: candidate.seqEnd,
    summaryText: candidate.summaryText,
    cosine: cosineSimilarity(anchor.vector, candidate.vector),
    entities: entityOverlap(anchor, candidate),
    lexical: lexicalOverlap(anchor, candidate),
    seqGap: direction === 'next'
      ? Math.max(0, candidate.seqStart - anchor.seqEnd)
      : Math.max(0, anchor.seqStart - candidate.seqEnd),
  };
}

export function scoreDirectionalCandidates(timeline, anchor, { direction = 'next', limit = Infinity } = {}) {
  if (direction !== 'next' && direction !== 'prev') throw new Error('direction must be next or prev');
  if (limit !== Infinity && (!Number.isInteger(limit) || limit < 0)) throw new Error('limit must be a nonnegative integer');
  const ordered = direction === 'next' ? timeline : [...timeline].reverse();
  const anchorIndex = ordered.findIndex((chunk) => chunk.chunkId === anchor.chunkId);
  if (anchorIndex < 0) throw new Error('anchor not found in timeline');
  const scored = ordered.slice(anchorIndex + 1, anchorIndex + 1 + limit).map((candidate, index) => ({
    ...scorePair(anchor, candidate, direction),
    ordinalGap: index + 1,
  }));
  const semanticRanks = new Map([...scored]
    .sort((left, right) => right.cosine - left.cosine || left.ordinalGap - right.ordinalGap)
    .map((candidate, index) => [candidate.chunkId, index + 1]));
  return scored.map((candidate) => ({ ...candidate, semanticRank: semanticRanks.get(candidate.chunkId) }));
}

/** Pick the strongest candidate inside a bounded temporal neighborhood. */
export function bestWithinWindow(scored, window) {
  if (!Number.isInteger(window) || window < 1) throw new Error('window must be a positive integer');
  return [...scored.filter((candidate) => candidate.ordinalGap <= window)]
    .sort((left, right) => right.cosine - left.cosine || left.ordinalGap - right.ordinalGap)[0] ?? null;
}

/** No threshold means measurement only: the shadow never silently picks a link. */
export function earliestAboveThreshold(scored, threshold) {
  if (threshold === undefined || threshold === null) return null;
  if (!Number.isFinite(threshold)) throw new Error('threshold must be finite');
  return scored.find((candidate) => candidate.cosine >= threshold) ?? null;
}

export function thresholdSweep(rows) {
  if (rows.some((row) => row.label !== 0 && row.label !== 1)) throw new Error('labels must be 0 or 1');
  const scores = [...new Set(rows.map((row) => row.cosine))].sort((a, b) => a - b);
  const thresholds = scores.length === 0 ? [] : [scores[0] - 1e-9, ...scores.map((score, index) => index + 1 < scores.length ? (score + scores[index + 1]) / 2 : score + 1e-9)];
  return thresholds.map((threshold) => {
    let tp = 0;
    let fp = 0;
    let tn = 0;
    let fn = 0;
    for (const row of rows) {
      const predicted = row.cosine >= threshold ? 1 : 0;
      if (predicted === 1 && row.label === 1) tp += 1;
      if (predicted === 1 && row.label === 0) fp += 1;
      if (predicted === 0 && row.label === 0) tn += 1;
      if (predicted === 0 && row.label === 1) fn += 1;
    }
    return {
      threshold,
      tp,
      fp,
      tn,
      fn,
      precision: tp + fp ? tp / (tp + fp) : null,
      recall: tp + fn ? tp / (tp + fn) : null,
      falsePositiveRate: fp + tn ? fp / (fp + tn) : null,
    };
  });
}

export function publicChunk(chunk) {
  return {
    chunkId: chunk.chunkId,
    turnId: chunk.turnId,
    chunkIndex: chunk.chunkIndex,
    seqStart: chunk.seqStart,
    seqEnd: chunk.seqEnd,
    summaryText: chunk.summaryText,
  };
}
