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

  async function beforeAnswer({ sessionId, query, cutoff, turns, events }) {
    if (!config.enabled || !allowedSession(sessionId)) return { enabled: false, ping: null, H: 0 };
    const empty = { text: '', bytes: 0, sha256: sha256(''), clipped: false, omittedHigh: 0 };
    const rawFallback = () => {
      if (config.rawIndex?.enabled === false) return null;
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
      const eligible = merged.summaries
        .map((summary, i) => ({ summary, vector: merged.vectors[i] }))
        .filter((row) => row.summary.availableCutoff !== null && row.summary.availableCutoff <= cutoff);
      if (eligible.length > 0) {
        const index = { summaries: eligible.map((row) => row.summary), vectors: eligible.map((row) => row.vector) };
        const scored = await queryIndex({ index, embedder, query, limit: config.retrieval.maxCandidatesPerFacet });
        const top = scored[0]?.score ?? 0;
        const threshold = Math.max(Number(config.retrieval.tau ?? 0), top - Number(config.retrieval.delta ?? 0));
        const high = scored.filter((row) => row.score >= threshold);
        const ping = buildChunkPing({ summaries: eligible.map((row) => row.summary), scored: high, cutoff, config });
        const result = { enabled: true, retrieval: { chunks: high, cutoff, top, threshold }, ping, H: high.length, indexVersion: active.identity, checkpoint: active.checkpoint };
        return high.length > 0 ? result : (rawFallback() ?? result);
      }
    }
    const storage = storageFor(sessionId);
    const summaries = await storage.summaries();
    if (summaries.length === 0) return rawFallback() ?? { enabled: true, ping: empty, H: 0 };
    const records = await storage.vectors();
    if (records.length === 0) return rawFallback() ?? { enabled: true, ping: empty, H: 0 };
    const index = createVectorIndex({ config, embedder, records });
    const retrieval = await retrieve({ query, cutoff, index, config });
    const summaryByTurn = new Map(summaries.filter((summary) => summary.availableCutoff <= cutoff).map((summary) => [summary.turnId, summary]));
    const turnList = turns ?? buildTurnsFromEvents(sessionId, events ?? []);
    const ping = buildPing({ summaryByTurn, retrieval, turns: turnList, config });
    const H = retrieval.facets.reduce((sum, facet) => sum + facet.H, 0);
    await storage.appendLedger({ at: new Date().toISOString(), kind: 'retrieval', querySha256: sha256(String(query)), cutoff, H, pingBytes: ping.bytes });
    const result = { enabled: true, retrieval, ping, H };
    return H > 0 ? result : (rawFallback() ?? result);
  }

  return { config, home, onFold, beforeAnswer, storageFor, rawIndexFor, indexVersion: indexVersion(config) };
}
