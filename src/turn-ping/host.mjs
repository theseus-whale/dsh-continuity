import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readConfig, sha256 } from './config.mjs';
import { buildSourceView, eventText, userSourceKind } from './source-view.mjs';
import { writeFoldSummaries } from './summary-writer.mjs';
import { createVectorIndex } from './vector-index.mjs';
import { retrieve } from './retrieval.mjs';
import { buildPing } from './ping.mjs';
import { createTurnPingStorage, turnPingRoot } from './storage.mjs';
import { loadActiveIndex } from '../fullseed/cache.mjs';
import { queryIndex } from '../fullseed/query.mjs';
import { buildChunkPing } from '../fullseed/ping.mjs';
import { createRawIndex, buildRawIndexPing, RAW_INDEX_VERSION } from './raw-index.mjs';
import { groupTurnEvents } from './turn-groups.mjs';
import { extractVisibleMemoryIds, markCueHistory, memoryIdentity, readQuietConfig, recentCueIds, recordCueDecision, selectNovelHits } from './quiet.mjs';
import { decodeRecallCursor, encodeRecallCursor, prototypePageCandidates, readRetrievalPrototype, selectPrototypeHits } from './retrieval-prototype.mjs';

const tokenText = (event) => eventText(event).trim();

export function buildTurnsFromEvents(sessionId, events) {
  return groupTurnEvents(events).map((group) => ({
    turnId: group.turnId,
    seqStart: group.start,
    seqEnd: Math.max(group.start, group.end),
    boundarySeqs: [group.start, Math.max(group.start, group.end)],
    rawTextSha256: sha256(group.allowed.map(tokenText).filter(Boolean).join('\n')),
    closed: group.closed,
    ...(group.hostStart !== undefined ? { hostStart: group.hostStart, hostEnd: group.hostEnd } : {}),
  }));
}

export function indexVersion(config) {
  return createHash('sha256').update(JSON.stringify({
    embedder: config.vector,
    summarizer: config.summary,
    extraction: config.sourceView,
    cutoffPolicy: 'fold-cutoff-v1',
  })).digest('hex');
}

export function createTurnPingHost({ config: overrides = {}, home, provider, embedder }) {
  const config = readConfig(overrides);
  if (!home) throw new Error('turn-ping host: home required');
  const hosts = new Map();
  const storageFor = (sessionId) => {
    const key = String(sessionId);
    if (!hosts.has(key)) hosts.set(key, createTurnPingStorage({ home, sessionId: key }));
    return hosts.get(key);
  };

  const rawIndexes = new Map();
  const rawIndexFor = (sessionId) => {
    const key = String(sessionId);
    if (!rawIndexes.has(key)) rawIndexes.set(key, createRawIndex({ home, sessionId: key }));
    return rawIndexes.get(key);
  };

  const allowed = Array.isArray(config.sessionIds) && config.sessionIds.length > 0 ? new Set(config.sessionIds.map(String)) : null;
  const allowedSession = (sessionId) => allowed === null || allowed.has(String(sessionId));
  async function onFold({ sessionId, fold, events, turns, eventsBySeq }) {
    if (!config.enabled || !allowedSession(sessionId)) return { enabled: false, writes: 0, vectors: 0 };
    if (config.foldWrites === false) return { enabled: true, writes: 0, vectors: 0, reason: 'fold-writes-disabled' };
    if (!fold || !Array.isArray(fold.shadowedSeqs) || fold.shadowedSeqs.length === 0) return { enabled: true, writes: 0, vectors: 0, reason: 'no-fold' };
    const allEvents = events ?? [];
    const eventMap = eventsBySeq ?? new Map(allEvents.map((event) => [Number(event.seq), event]));
    const turnList = turns ?? buildTurnsFromEvents(sessionId, allEvents);
    const storage = storageFor(sessionId);
    const summaryStore = {
      async put(key, summary) { return storage.appendSummary(summary); },
    };
    const vectors = await storage.vectors();
    const index = createVectorIndex({
      config,
      embedder,
      records: vectors.map((record) => ({ ...record, vector: record.vector })),
    });
    const vectorStore = {
      async append(summary) {
        const record = await index.append(summary);
        if (record) await storage.appendVector(record);
        return record;
      },
    };
    const writtenKeys = new Set((await storage.summaries()).map((summary) => `${sessionId}:${summary.seqStart}:${summary.seqEnd}:${summary.rawTextSha256}`));
    const result = await writeFoldSummaries({
      sessionId,
      fold: { ...fold, from: fold.from ?? Math.min(...fold.shadowedSeqs), to: fold.to ?? Math.max(...fold.shadowedSeqs) },
      turns: turnList,
      eventsBySeq: eventMap,
      provider,
      summaryStore,
      vectorStore,
      config,
      writtenKeys,
    });
    await storage.writeVectorMeta({ indexVersion: indexVersion(config), model: config.vector.model, dimensions: config.vector.dimensions });
    await storage.appendLedger({ at: new Date().toISOString(), kind: 'on-fold', foldId: fold.compactionId ?? fold.foldId ?? null, writes: result.writes, vectors: result.vectors });
    return { enabled: true, ...result };
  }

  async function beforeAnswer({ sessionId, query, cutoff, turns, events, quiet = false, visibleMemoryIds = new Set(), cursor = null, beforeSeq = null }) {
    if (!config.enabled || !allowedSession(sessionId)) return { enabled: false, ping: null, H: 0 };
    const empty = { text: '', bytes: 0, sha256: sha256(''), clipped: false, omittedHigh: 0 };
    const quietConfig = readQuietConfig(config);
    const prototype = readRetrievalPrototype(config);
    const useHighQuality = prototype.enabled;
    const usePrototype = useHighQuality && !quiet;
    if ((cursor !== null || beforeSeq !== null) && !usePrototype) throw new Error('memory_recall: cursor and beforeSeq require manual full-library retrieval');
    if (beforeSeq !== null && (!Number.isInteger(beforeSeq) || beforeSeq < 1)) throw new Error('memory_recall: beforeSeq must be a positive integer');
    let effectiveCutoff = beforeSeq === null ? cutoff : Math.min(cutoff, beforeSeq - 1);
    let excludeIds = new Set();
    let paginationOffset = 0;
    const historyRoot = turnPingRoot({ home, sessionId });
    const referenceIds = quiet ? new Set([...visibleMemoryIds, ...recentCueIds(historyRoot, Date.now(), quietConfig.historyWindowMs)]) : new Set();
    const finishQuiet = ({ ping, candidates }) => {
      if (!quiet) return [];
      const shownIds = ping?.text ? [...extractVisibleMemoryIds(ping.text)] : [];
      recordCueDecision(historyRoot, {
        mode: quietConfig.mode, query, injected: Boolean(ping?.text),
        candidates: candidates.map(hit => ({ id: memoryIdentity(hit.summary ?? hit), score: hit.score })),
        referenceIds: [...referenceIds], acceptedIds: shownIds,
        reason: candidates.length === 0 ? 'no-candidate' : shownIds.length === 0 ? 'duplicate-or-not-novel' : 'accepted',
      });
      if (shownIds.length) markCueHistory(historyRoot, shownIds);
      return shownIds;
    };
    const rawFallback = () => {
      if (quiet || config.rawIndex?.enabled === false) return null;
      const hits = rawIndexFor(sessionId).search(query, { beforeSeq: cutoff });
      const ping = buildRawIndexPing(hits);
      if (!ping) return null;
      return {
        enabled: true, ping, H: hits.length, indexVersion: RAW_INDEX_VERSION,
        retrieval: { raw: true, cutoff, hits: hits.map((hit) => ({ seq: hit.seq, rawTextSha256: hit.rawTextSha256, score: hit.score })) },
      };
    };
    const fullseedRoot = path.join(turnPingRoot({ home, sessionId }), 'fullseed');
    const cached = loadActiveIndex(fullseedRoot);
    if (cached) {
      const { active, merged } = cached;
      if (usePrototype && cursor !== null) {
        const decoded = decodeRecallCursor(cursor, { query, indexIdentity: active.identity, beforeSeq }, prototype.maxCursorIds);
        excludeIds = decoded.excludeIds;
        paginationOffset = decoded.offset;
        effectiveCutoff = beforeSeq === null ? decoded.cutoff : Math.min(decoded.cutoff, beforeSeq - 1);
      }
      const eligible = merged.summaries
        .map((summary, i) => ({ summary, vector: merged.vectors[i] }))
        .filter((row) => row.summary.availableCutoff !== null && row.summary.availableCutoff <= effectiveCutoff)
        .filter((row) => beforeSeq === null || Number(row.summary.seqEnd) < beforeSeq);
      if (usePrototype && eligible.length === 0) {
        return {
          enabled: true, ping: empty, H: 0, shownIds: [], nextCursor: null,
          retrieval: { chunks: [], cutoff: effectiveCutoff, requestedCutoff: cutoff, top: 0, threshold: config.retrieval.tau, quiet, beforeSeq, prototype: { enabled: true, candidateCount: 0, totalCount: 0, relevantCount: 0, explorationCount: 0 } },
          indexVersion: active.identity, checkpoint: active.checkpoint,
        };
      }
      if (eligible.length > 0) {
        const index = { summaries: eligible.map((row) => row.summary), vectors: eligible.map((row) => row.vector) };
        const candidateLimit = useHighQuality ? eligible.length : config.retrieval.maxCandidatesPerFacet;
        const scored = await queryIndex({ index, embedder, query, limit: candidateLimit });
        let top = scored[0]?.score ?? 0;
        const tau = quiet ? quietConfig.tau : Number(config.retrieval.tau ?? 0);
        const delta = quiet ? quietConfig.delta : Number(config.retrieval.delta ?? 0);
        let threshold = Math.max(tau, top - delta);
        let high = scored.filter((row) => row.score >= threshold);
        let selection = null;
        let page = null;
        if (useHighQuality) {
          const selectionConfig = quiet ? {
            ...config,
            retrieval: {
              ...config.retrieval,
              tau: quietConfig.tau,
              delta: quietConfig.delta,
              prototype: { ...config.retrieval.prototype, noveltyThreshold: quietConfig.noveltyThreshold },
            },
          } : config;
          page = prototypePageCandidates({ scored, config: selectionConfig, offset: paginationOffset });
          const excludedIds = quiet ? referenceIds : excludeIds;
          const referenceSource = quiet ? eligible : page.candidates;
          const references = referenceSource.filter(row => excludedIds.has(memoryIdentity(row.summary)) || excludedIds.has(row.summary.turnId)).map(row => row.vector);
          selection = selectPrototypeHits({ scored: page.candidates, config: selectionConfig, excludeIds: excludedIds, referenceVectors: references });
          selection.diagnostics.totalCount = page.totalCount;
          selection.diagnostics.offset = page.offset;
          selection.diagnostics.stratifiedCount = page.stratifiedCount;
          high = selection.high;
          top = selection.top;
          threshold = selection.threshold;
        } else if (quiet) {
          const references = eligible.filter(row => referenceIds.has(memoryIdentity(row.summary)) || referenceIds.has(row.summary.turnId)).map(row => row.vector);
          high = selectNovelHits(high.filter(row => !referenceIds.has(memoryIdentity(row.summary)) && !referenceIds.has(row.summary.turnId)), references, quietConfig.noveltyThreshold);
        }
        const ping = buildChunkPing({ summaries: eligible.map((row) => row.summary), scored: high, cutoff: effectiveCutoff, config });
        const shownIds = finishQuiet({ ping, candidates: high });
        const hasMoreRelevant = Boolean(usePrototype && page
          && page.nextOffset < scored.length
          && scored[page.nextOffset]?.score >= config.retrieval.tau);
        if (usePrototype && selection) selection.diagnostics.hasMoreRelevant = hasMoreRelevant;
        let nextCursor = null;
        if (hasMoreRelevant) {
          const extraShownIds = high.filter(row => !page.window.includes(row)).map(row => memoryIdentity(row.summary)).filter(Boolean);
          const explorationIds = [...new Set([...excludeIds, ...extraShownIds])];
          if (explorationIds.length <= prototype.maxCursorIds) {
            nextCursor = encodeRecallCursor({
              query, indexIdentity: active.identity, checkpoint: active.checkpoint,
              cutoff: effectiveCutoff, beforeSeq, offset: page.nextOffset, explorationIds,
            });
          }
        }
        const result = {
          enabled: true,
          retrieval: {
            chunks: high, cutoff: usePrototype ? effectiveCutoff : cutoff, top, threshold, quiet,
            ...(useHighQuality ? { prototype: selection?.diagnostics ?? null } : {}),
            ...(usePrototype ? { requestedCutoff: cutoff, beforeSeq } : {}),
          },
          ping, H: high.length, shownIds, indexVersion: active.identity, checkpoint: active.checkpoint,
          ...(usePrototype ? { nextCursor } : {}),
        };
        return high.length > 0 || usePrototype ? result : (rawFallback() ?? result);
      }
    }
    if (usePrototype) throw new Error('memory_recall: full-library retrieval requires an active fullseed index');
    const storage = storageFor(sessionId);
    const summaries = await storage.summaries();
    if (summaries.length === 0) return rawFallback() ?? { enabled: true, ping: empty, H: 0 };
    const records = await storage.vectors();
    if (records.length === 0) return rawFallback() ?? { enabled: true, ping: empty, H: 0 };
    const activeConfig = quiet ? { ...config, retrieval: { ...config.retrieval, tau: quietConfig.tau, delta: quietConfig.delta } } : config;
    const index = createVectorIndex({ config: activeConfig, embedder, records });
    const retrieval = await retrieve({
      query, cutoff, index, config: activeConfig,
      ...(quiet ? { quiet: {
        referenceIds, referenceVectors: records.filter(record => referenceIds.has(record.turnId)).map(record => record.vector),
        noveltyThreshold: quietConfig.noveltyThreshold,
      } } : {}),
    });
    const summaryByTurn = new Map(summaries.filter((summary) => summary.availableCutoff <= cutoff).map((summary) => [summary.turnId, summary]));
    const turnList = turns ?? buildTurnsFromEvents(sessionId, events ?? []);
    const ping = buildPing({ summaryByTurn, retrieval, turns: turnList, config: activeConfig });
    const H = retrieval.facets.reduce((sum, facet) => sum + facet.H, 0);
    const shownIds = finishQuiet({ ping, candidates: retrieval.facets.flatMap(facet => facet.high) });
    await storage.appendLedger({ at: new Date().toISOString(), kind: 'retrieval', querySha256: sha256(String(query)), cutoff, H, pingBytes: ping.bytes });
    const result = { enabled: true, retrieval, ping, H, shownIds };
    return H > 0 ? result : (rawFallback() ?? result);
  }

  return { config, home, onFold, beforeAnswer, storageFor, rawIndexFor, indexVersion: indexVersion(config) };
}
