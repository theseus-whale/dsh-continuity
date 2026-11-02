/**
 * Topic-shift detector for the B+C trigger layer.
 *
 * Compares the previous and current turn states. The LLM does not decide
 * whether a shift happened; it only sees one note after the detector fires.
 */

function setOf(values) {
  return new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean));
}

export function jaccard(a, b) {
  const left = setOf(a);
  const right = setOf(b);
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

/** Normalize a recall record into the fields used by the detector. */
export function shiftState(record, { turn = null } = {}) {
  return {
    turn: turn ?? record?.turn ?? null,
    generic: record?.generic ?? [],
    keywords: record?.keywords ?? [],
    terms: record?.terms ?? [],
  };
}

export function detectShift(previous, current, {
  genericWeight = 0.6,
  keywordWeight = 0.4,
  threshold = 0.55,
} = {}) {
  if (!previous || !current) return { kind: 'unknown', score: 0, reasons: ['missing-state'] };
  const genericSimilarity = jaccard(previous.generic, current.generic);
  const keywordSimilarity = jaccard(previous.keywords, current.keywords);
  const similarity = genericWeight * genericSimilarity + keywordWeight * keywordSimilarity;
  const score = 1 - similarity;
  const reasons = [];
  if (genericSimilarity < 0.25) reasons.push('generic-change');
  if (keywordSimilarity < 0.25) reasons.push('keyword-change');
  return {
    kind: score >= threshold ? 'shift' : 'same',
    score: Number(score.toFixed(3)),
    genericSimilarity: Number(genericSimilarity.toFixed(3)),
    keywordSimilarity: Number(keywordSimilarity.toFixed(3)),
    reasons,
  };
}

export function shouldTrigger({ previous, current, cue = false, threshold = 0.55 } = {}) {
  if (cue) return { trigger: true, reason: 'explicit-recall-cue' };
  const shift = detectShift(previous, current, { threshold });
  if (shift.kind === 'shift') return { trigger: true, reason: 'topic-shift', shift };
  return { trigger: false, reason: 'same-topic', shift };
}

function aggregate(records = []) {
  const generic = new Set();
  const keywords = new Set();
  for (const record of records) {
    for (const value of record.generic ?? []) generic.add(value);
    for (const value of record.keywords ?? []) keywords.add(value);
  }
  return { generic: [...generic], keywords: [...keywords] };
}

/**
 * TextTiling-style boundary: compare a window on each side of the boundary,
 * not two single turns. This smooths turn-to-turn B-label drift.
 */
export function detectWindowShift(records = [], boundary, {
  window = 3,
  genericWeight = 0.6,
  keywordWeight = 0.4,
  threshold = 0.55,
} = {}) {
  if (boundary <= 0 || boundary >= records.length) return { kind: 'unknown', score: 0, reasons: ['no-boundary'] };
  const leftRecords = records.slice(Math.max(0, boundary - window), boundary);
  const rightRecords = records.slice(boundary, Math.min(records.length, boundary + window));
  if (leftRecords.length === 0 || rightRecords.length === 0) return { kind: 'unknown', score: 0, reasons: ['short-window'] };
  const left = aggregate(leftRecords);
  const right = aggregate(rightRecords);
  const genericSimilarity = jaccard(left.generic, right.generic);
  const keywordSimilarity = jaccard(left.keywords, right.keywords);
  const similarity = genericWeight * genericSimilarity + keywordWeight * keywordSimilarity;
  const score = 1 - similarity;
  const reasons = [];
  if (genericSimilarity < 0.25) reasons.push('generic-change');
  if (keywordSimilarity < 0.25) reasons.push('keyword-change');
  return {
    kind: score >= threshold ? 'shift' : 'same',
    score: Number(score.toFixed(3)),
    genericSimilarity: Number(genericSimilarity.toFixed(3)),
    keywordSimilarity: Number(keywordSimilarity.toFixed(3)),
    left: [leftRecords[0]?.turn, leftRecords.at(-1)?.turn],
    right: [rightRecords[0]?.turn, rightRecords.at(-1)?.turn],
    reasons,
  };
}

export function detectSequence(records = [], options = {}) {
  const boundaries = [];
  for (let index = 1; index < records.length; index += 1) {
    if (records[index].turn - records[index - 1].turn !== 1) continue;
    const shift = detectWindowShift(records, index, options);
    if (shift.kind === 'shift') boundaries.push({ turn: records[index].turn, ...shift });
  }
  return boundaries;
}

export function renderShiftNote({ previous, current, shift, sources = {} } = {}) {
  const from = previous?.turn ?? '?';
  const to = current?.turn ?? '?';
  const lines = [`[追忆] 话题变化 turn ${from} -> ${to}`];
  if (shift?.reasons?.length) lines.push(`原因：${shift.reasons.join(' / ')}`);
  if (sources.gist) lines.push(`gist：${sources.gist}`);
  if (sources.facets?.length) lines.push(`B+C facet：${sources.facets.join(' / ')}`);
  if (sources.keywords?.length) lines.push(`BM25：${sources.keywords.slice(0, 6).join(' / ')}`);
  return lines.join('\n');
}
