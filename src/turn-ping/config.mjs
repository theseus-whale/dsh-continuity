/**
 * Default-off configuration for the turn-ping memory module.
 * No live/default/session behavior is enabled by these values.
 */
export const DEFAULT_CONFIG = Object.freeze({
  version: 'turn-ping-v1',
  enabled: false,
  mode: 'shadow',
  summary: Object.freeze({
    level: 'L',
    targetChars: 256,
    hardMaxChars: 256, // legacy compatibility only; never a rejection threshold
    maxAttempts: 2,
    promptVersion: 'turn-ping-summary-v2-soft',
    model: 'deepseek-chat',
    temperature: 0,
  }),
  sourceView: Object.freeze({
    userChars: 4000,
    assistantChars: 5000,
    toolChars: 1500,
    totalChars: 16000,
    userSourceKinds: Object.freeze(['user', 'peer']),
  }),
  vector: Object.freeze({
    model: 'BAAI/bge-small-zh-v1.5',
    dimensions: 512,
    normalize: 'cls-l2',
    queryInstruction: '为这个句子生成表示以用于检索相关文章：',
    documentInstruction: '',
    exactScanOnly: true,
  }),
  retrieval: Object.freeze({
    tau: 0.45,
    delta: 0.08,
    maxCandidatesPerFacet: 12,
    maxFacets: 4,
    maxUnits: 64,
    facetSimilarityThreshold: 0.82,
    maxSummariesPerFacet: 4,
    maxSummariesGlobal: 12,
    maxSeqRefsPerFacet: 8,
    maxPingUtf8Bytes: 16384,
  }),
  raw: Object.freeze({
    maxReadsPerAnswer: 2,
    maxBytesPerRead: 4096,
    maxProviderCalls: 4,
    finalNoToolAnswer: true,
  }),
  boundaries: Object.freeze({
    allowLiveInjection: false,
    allowDefaultEnable: false,
    allowCrossSession: false,
    allowBm25: false,
    allowRrf: false,
    allowSearchLlm: false,
    allowPlanner: false,
    allowAutoFuzzyTool: false,
  }),
});

const merge = (base, override) => {
  if (override === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) out[key] = merge(base[key], value);
  return out;
};

export function readConfig(overrides = {}) {
  const config = merge(DEFAULT_CONFIG, overrides);
  if (config.enabled && !config.boundaries.allowDefaultEnable) {
    throw new Error('turn-ping: enabled=true requires explicit default/live approval');
  }
  if (config.mode !== 'shadow' && config.mode !== 'opt-in') {
    throw new Error('turn-ping: mode must be shadow or opt-in');
  }
  return config;
}

export function configSha256(config) {
  return sha256(JSON.stringify(config));
}

import crypto from 'node:crypto';
export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
