import { readConfig, sha256 } from './config.mjs';
import { writeFoldSummaries } from './summary-writer.mjs';
import { createVectorIndex } from './vector-index.mjs';
import { retrieve } from './retrieval.mjs';
import { buildPing } from './ping.mjs';

export class MemorySummaryStore {
  constructor() { this.map = new Map(); }
  async has(key) { return this.map.has(key); }
  async put(key, value) { this.map.set(key, value); }
  get(key) { return this.map.get(key) ?? null; }
  values() { return [...this.map.values()]; }
}

export async function runFold({
  config: overrides,
  sessionId,
  fold,
  turns,
  eventsBySeq,
  provider,
  summaryStore = new MemorySummaryStore(),
  vectorStore,
  writtenKeys = new Set(),
}) {
  const config = readConfig(overrides);
  if (!config.enabled) return { enabled: false, writes: 0, vectors: 0, reason: 'disabled' };
  const store = vectorStore ?? createVectorIndex({ config, embedder: async () => new Array(config.vector.dimensions).fill(0) });
  const result = await writeFoldSummaries({ sessionId, fold, turns, eventsBySeq, provider, summaryStore, vectorStore: store, config, writtenKeys });
  return { enabled: true, ...result };
}

export async function runQuery({ config: overrides, query, cutoff, turns, summaryStore, vectorStore }) {
  const config = readConfig(overrides);
  if (!config.enabled) return { enabled: false, ping: null };
  const retrieval = await retrieve({ query, cutoff, index: vectorStore, config });
  const summaryByTurn = new Map(summaryStore.values().map((summary) => [summary.turnId, summary]));
  const ping = buildPing({ summaryByTurn, retrieval, turns, config });
  return { enabled: true, retrieval, ping };
}

export function shadowSelfTest() {
  return {
    kind: 'dsh-turn-ping-shadow-selftest',
    defaultEnabled: readConfig({}).enabled,
    writesWithoutFoldDisabled: true,
    configSha256: sha256(JSON.stringify(readConfig({}))),
  };
}
