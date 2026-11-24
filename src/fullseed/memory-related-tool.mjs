import path from 'node:path';
import { continuityHome } from '../folds-store.mjs';
import { turnPingRoot } from '../turn-ping/storage.mjs';
import { loadActiveIndex } from './cache.mjs';
import {
  bestWithinWindow,
  buildChunkTimeline,
  publicChunk,
  scoreDirectionalCandidates,
} from './continuation-shadow.mjs';

export const MEMORY_RELATED_MAX_WINDOW = 20;

function sameVector(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Ignore exact physical copies left by overlapping deltas, but never merge conflicting content. */
export function buildRelatedTimeline(summaries, vectors) {
  if (summaries.length !== vectors.length) throw new Error('summary/vector count mismatch');
  const seen = new Map();
  const uniqueSummaries = [];
  const uniqueVectors = [];
  for (let index = 0; index < summaries.length; index += 1) {
    const summary = summaries[index];
    const vector = vectors[index];
    const previousIndex = seen.get(summary.chunkId);
    if (previousIndex === undefined) {
      seen.set(summary.chunkId, uniqueSummaries.length);
      uniqueSummaries.push(summary);
      uniqueVectors.push(vector);
      continue;
    }
    const previous = uniqueSummaries[previousIndex];
    const sameIdentity = previous.turnId === summary.turnId
      && previous.chunkIndex === summary.chunkIndex
      && previous.seqStart === summary.seqStart
      && previous.seqEnd === summary.seqEnd
      && previous.summarySha256 === summary.summarySha256;
    if (!sameIdentity || !sameVector(uniqueVectors[previousIndex], vector)) {
      throw new Error(`memory_related: conflicting active chunkId ${summary.chunkId}`);
    }
  }
  return buildChunkTimeline(uniqueSummaries, uniqueVectors);
}

function navigationCoordinates(chunk) {
  return chunk ? {
    chunkId: chunk.chunkId,
    turnId: chunk.turnId,
    chunkIndex: chunk.chunkIndex,
    seqStart: chunk.seqStart,
    seqEnd: chunk.seqEnd,
  } : null;
}

/** Chronological neighbors are coordinate-only and independent of semantic ranking. */
export function relatedNavigation(timeline, anchor) {
  const index = timeline.findIndex((chunk) => chunk.chunkId === anchor.chunkId);
  if (index < 0) throw new Error('memory_related: anchor not found in timeline');
  return {
    prev: navigationCoordinates(index > 0 ? timeline[index - 1] : null),
    next: navigationCoordinates(index + 1 < timeline.length ? timeline[index + 1] : null),
  };
}

/** Resolve the summary chunk, never the raw seq text, used as the semantic anchor. */
export function resolveRelatedAnchor(timeline, { chunkId, turnId, seq, chunkIndex } = {}) {
  const supplied = [chunkId !== undefined, turnId !== undefined, seq !== undefined].filter(Boolean).length;
  if (supplied !== 1) throw new Error('memory_related: supply exactly one of chunkId, turnId, or seq');
  if (chunkId !== undefined && chunkIndex !== undefined) throw new Error('memory_related: chunkIndex is only used with turnId or seq');
  if (chunkIndex !== undefined && (!Number.isInteger(chunkIndex) || chunkIndex < 0)) throw new Error('memory_related: invalid chunkIndex');
  let matches;
  if (chunkId !== undefined) matches = timeline.filter((chunk) => chunk.chunkId === String(chunkId));
  else if (turnId !== undefined) matches = timeline.filter((chunk) => chunk.turnId === String(turnId)
    && (chunkIndex === undefined || chunk.chunkIndex === chunkIndex));
  else {
    if (!Number.isInteger(seq) || seq < 1) throw new Error('memory_related: seq must be a positive integer');
    matches = timeline.filter((chunk) => chunk.seqStart <= seq && chunk.seqEnd >= seq
      && (chunkIndex === undefined || chunk.chunkIndex === chunkIndex));
  }
  if (matches.length === 0) throw new Error('memory_related: anchor not found in active index');
  if (matches.length > 1) {
    const choices = matches.map((chunk) => `${chunk.turnId}#${chunk.chunkIndex} seq ${chunk.seqStart}-${chunk.seqEnd} ${chunk.chunkId}`).join('\n');
    throw new Error(`memory_related: anchor has multiple summary chunks; retry with chunkIndex or chunkId:\n${choices}`);
  }
  return matches[0];
}

export function createMemoryRelatedTool({ resolveRoot } = {}) {
  return {
    name: 'memory_related',
    description: 'Find semantically similar summary chunks near a known memory point. Typical workflow: memory_recall to find a HIT, then memory_related with its turnId or seq to explore nearby chunks, then read_seq_range to verify raw text. Prefer turnId or seq; use chunkIndex or chunkId to disambiguate multiple chunks within one turn. window defaults to 5: 1..20 searches next, -1..-20 searches prev, and 0 is invalid. Returns anchor nav with coordinate-only chronological prev/next, plus up to three ranked candidates; selected is the strongest and includes its summary, while candidates contain coordinates and scores only. nav answers chronological order; candidates answer semantic similarity, which does not prove continuation.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chunkId: { type: 'string', description: 'Canonical summary-chunk anchor for exact disambiguation when a turn has multiple chunks.' },
        turnId: { type: 'string', description: 'Preferred natural-turn anchor such as turn-000335; add chunkIndex if that turn has multiple chunks.' },
        seq: { type: 'integer', minimum: 1, description: 'Preferred convenience anchor matching a summary chunk containing this seq.' },
        chunkIndex: { type: 'integer', minimum: 0, description: 'Optional summary-chunk index within a turn; required when turnId or seq is ambiguous.' },
        window: { type: 'integer', minimum: -20, maximum: 20, description: 'Signed neighborhood size; default 5. Positive=next, negative=prev, zero is invalid.' },
      },
      required: [],
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value ?? '') }] },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    async execute(args = {}, exec = {}) {
      const sessionId = exec?.agent?.session?.id;
      if (!sessionId && typeof resolveRoot !== 'function') throw new Error('memory_related: no current session');
      const root = typeof resolveRoot === 'function'
        ? resolveRoot({ sessionId: sessionId === undefined ? null : String(sessionId), exec })
        : path.join(turnPingRoot({ home: continuityHome(), sessionId: String(sessionId) }), 'fullseed');
      if (!root) throw new Error('memory_related: fullseed root unavailable');
      const active = loadActiveIndex(path.resolve(root));
      if (!active) return JSON.stringify({ selected: null, candidates: [], reason: 'active-index-not-found' });
      const timeline = buildRelatedTimeline(active.merged.summaries, active.merged.vectors);
      const anchor = resolveRelatedAnchor(timeline, args);
      const window = args.window ?? 5;
      if (!Number.isInteger(window) || window === 0 || Math.abs(window) > MEMORY_RELATED_MAX_WINDOW) {
        throw new Error('memory_related: window must be a nonzero integer from -20 to 20');
      }
      const direction = window < 0 ? 'prev' : 'next';
      const scored = scoreDirectionalCandidates(timeline, anchor, { direction, limit: Math.abs(window) });
      const ranked = [...scored].sort((left, right) => right.cosine - left.cosine || left.ordinalGap - right.ordinalGap);
      const selected = bestWithinWindow(scored, Math.abs(window));
      const candidates = ranked.slice(0, 3).map((candidate) => ({
        chunkId: candidate.chunkId,
        turnId: candidate.turnId,
        chunkIndex: candidate.chunkIndex,
        seqStart: candidate.seqStart,
        seqEnd: candidate.seqEnd,
        cosine: candidate.cosine,
        ordinalGap: candidate.ordinalGap,
      }));
      return JSON.stringify({
        anchor: publicChunk(anchor),
        nav: relatedNavigation(timeline, anchor),
        direction,
        window: Math.abs(window),
        candidateCount: scored.length,
        selected: selected ? {
          ...publicChunk(selected),
          cosine: selected.cosine,
          ordinalGap: selected.ordinalGap,
        } : null,
        candidates,
        checkpoint: active.active.checkpoint ?? null,
        note: '仅为窗口内语义最相似的摘要块，不保证属于同一事情线；按 seq 回读原文。',
      });
    },
  };
}

export function apply(ctx, config = {}) {
  const home = config.home ?? config.continuityHome ?? continuityHome();
  const tool = createMemoryRelatedTool({
    resolveRoot: ({ sessionId }) => path.join(turnPingRoot({ home, sessionId }), 'fullseed'),
  });
  ctx.effect(() => ctx.tools.register(tool));
  return tool;
}

export const name = 'memory-related-tool';
export const inject = ['tools'];
