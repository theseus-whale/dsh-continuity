import { sha256 } from './config.mjs';
import { selectNovelHits } from './quiet.mjs';

const identity = (row) => row?.summary?.chunkId ?? row?.summary?.turnId ?? row?.chunkId ?? row?.turnId ?? '';
const turnIdentity = (row) => row?.summary?.turnId ?? row?.turnId ?? '';
const seqStart = (row) => Number(row?.summary?.seqStart ?? row?.seqStart);
const excluded = (row, ids) => ids.has(identity(row)) || ids.has(turnIdentity(row));
const validVector = (row) => Array.isArray(row?.vector) && row.vector.length > 0;

export function readRetrievalPrototype(config) {
  const value = config?.retrieval?.prototype ?? {};
  const integer = (input, fallback, min, max) => Number.isInteger(input) && input >= min && input <= max ? input : fallback;
  return {
    enabled: value.enabled === true,
    candidatePool: integer(value.candidatePool, 48, 12, 512),
    noveltyThreshold: Number.isFinite(value.noveltyThreshold) && value.noveltyThreshold > 0 && value.noveltyThreshold <= 1 ? value.noveltyThreshold : 0.75,
    temporalSlots: integer(value.temporalSlots, 1, 0, 4),
    temporalBuckets: integer(value.temporalBuckets, 4, 2, 32),
    maxCursorIds: integer(value.maxCursorIds, 64, 4, 128),
  };
}

/**
 * Build one page from the full relevance ranking. The first page also receives
 * the best relevant candidate from each seq bucket, so a recent semantic cluster
 * cannot hide every older candidate. Later pages resume at the global offset.
 */
export function prototypePageCandidates({ scored, config, offset = 0 }) {
  const settings = readRetrievalPrototype(config);
  const window = scored.slice(offset, offset + settings.candidatePool);
  const page = {
    window,
    candidates: window,
    stratifiedCount: 0,
    totalCount: scored.length,
    offset,
    nextOffset: offset + settings.candidatePool,
  };
  if (offset !== 0 || window.length === 0 || settings.temporalSlots === 0) return page;
  const relevant = scored.filter(row => row.score >= config.retrieval.tau);
  const seqs = relevant.map(seqStart).filter(Number.isFinite);
  if (seqs.length === 0) return page;
  const minSeq = Math.min(...seqs);
  const maxSeq = Math.max(...seqs);
  if (minSeq === maxSeq) return page;
  const width = (maxSeq - minSeq + 1) / settings.temporalBuckets;
  const extras = [];
  for (let bucket = 0; bucket < settings.temporalBuckets; bucket += 1) {
    const lower = minSeq + bucket * width;
    const upper = bucket === settings.temporalBuckets - 1 ? maxSeq + 1 : lower + width;
    const best = relevant.find(row => {
      const seq = seqStart(row);
      return Number.isFinite(seq) && seq >= lower && seq < upper && !window.includes(row);
    });
    if (best) extras.push(best);
  }
  page.candidates = [...window, ...extras];
  page.stratifiedCount = extras.length;
  return page;
}

/**
 * The original top and relative threshold are never recomputed after
 * deduplication. Only relevant candidates can fill temporal exploration slots.
 */
export function selectPrototypeHits({ scored, config, excludeIds = new Set(), referenceVectors = [] }) {
  const settings = readRetrievalPrototype(config);
  const top = scored[0]?.score ?? 0;
  const threshold = Math.max(config.retrieval.tau, top - config.retrieval.delta);
  const available = scored.filter(row => !excluded(row, excludeIds));
  const relevant = available.filter(row => row.score >= config.retrieval.tau);
  const main = relevant.filter(row => row.score >= threshold);
  const mainNovel = selectNovelHits(main, referenceVectors, settings.noveltyThreshold);
  const displayLimit = Math.max(1, config.retrieval.maxSummariesPerFacet);
  const seqs = relevant.map(seqStart).filter(Number.isFinite);
  const minSeq = seqs.length ? Math.min(...seqs) : null;
  const maxSeq = seqs.length ? Math.max(...seqs) : null;
  const oldBoundary = minSeq === null ? null : minSeq + (maxSeq - minSeq) / settings.temporalBuckets;

  const chooseExploration = mainShown => {
    if (settings.temporalSlots === 0 || oldBoundary === null || maxSeq === minSeq) return [];
    const earliestMain = Math.min(...mainShown.map(seqStart).filter(Number.isFinite), Infinity);
    const old = relevant.filter(row => {
      const seq = seqStart(row);
      return !mainShown.includes(row) && Number.isFinite(seq) && seq <= oldBoundary && seq < earliestMain;
    });
    const references = [...referenceVectors, ...mainShown.filter(validVector).map(row => row.vector)];
    return selectNovelHits(old, references, settings.noveltyThreshold).slice(0, settings.temporalSlots);
  };

  let mainShown = mainNovel.slice(0, displayLimit);
  let exploration = chooseExploration(mainShown);
  mainShown = mainNovel.slice(0, Math.max(0, displayLimit - exploration.length));
  exploration = chooseExploration(mainShown);
  const high = [...mainShown, ...exploration];
  const remaining = relevant.filter(row => !high.includes(row));
  const remainingReferences = [...referenceVectors, ...high.filter(validVector).map(row => row.vector)];
  const hasMore = selectNovelHits(remaining, remainingReferences, settings.noveltyThreshold).length > 0;
  return {
    high,
    top,
    threshold,
    hasMore,
    diagnostics: {
      enabled: true,
      candidateCount: scored.length,
      relevantCount: relevant.length,
      mainCount: main.length,
      selectedMainCount: mainShown.length,
      explorationCount: exploration.length,
      explorationIds: exploration.map(identity),
      excludedCount: scored.length - available.length,
      remainingCount: remaining.length,
      seqStart: minSeq,
      seqEnd: maxSeq,
    },
  };
}

export function encodeRecallCursor({ query, indexIdentity, checkpoint, cutoff, beforeSeq = null, offset = 0, explorationIds = [] }) {
  return Buffer.from(JSON.stringify({
    v: 2,
    queryHash: sha256(String(query)),
    indexIdentity,
    checkpoint,
    cutoff,
    beforeSeq,
    offset,
    explorationIds: [...new Set(explorationIds)],
  }), 'utf8').toString('base64url');
}

export function decodeRecallCursor(cursor, expected, maxCursorIds = 64) {
  try {
    if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 32768) throw new Error('invalid length');
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const matches = value.v === 2
      && value.queryHash === sha256(String(expected.query))
      && value.indexIdentity === expected.indexIdentity
      && value.beforeSeq === expected.beforeSeq
      && Number.isInteger(value.cutoff)
      && value.cutoff >= 0
      && Number.isInteger(value.offset)
      && value.offset >= 0;
    if (!matches || !Array.isArray(value.explorationIds) || value.explorationIds.length > maxCursorIds) throw new Error('cursor mismatch');
    if (value.explorationIds.some(id => typeof id !== 'string' || id.length === 0 || id.length > 256)) throw new Error('invalid exclusion');
    // checkpoint advances after ordinary turns. Pin the original cutoff instead,
    // so newly appended summaries cannot enter or invalidate this pagination.
    const explorationIds = new Set(value.explorationIds);
    return { excludeIds: explorationIds, explorationIds, offset: value.offset, cutoff: value.cutoff };
  } catch {
    throw new Error('memory_recall: cursor does not match this query, index, cutoff, or beforeSeq');
  }
}
