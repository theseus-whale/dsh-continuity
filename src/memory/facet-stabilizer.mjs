/**
 * Stabilize a noisy local facet head with lexical aliases and retrieval votes.
 * This is a deterministic system layer, not an LLM decision.
 */
import { DEFAULT_ALIASES } from '../facets/schema.mjs';

const START_RUN = /开始(?:跑团|一局|团|游戏|新的)|开个新团|新团|开新团|来一局|开团|开一局|进入.*(?:跑团|灯室|游戏)|跑团吧|TRPG/iu;

export function lexicalFacet(text, { startOnly = false } = {}) {
  const keys = Object.keys(DEFAULT_ALIASES).sort((a, b) => b.length - a.length);
  const alias = keys.find((key) => text.includes(key));
  const start = START_RUN.test(text);
  if (!start && startOnly) return null;
  if (start) return { activity: '跑团', source: 'start-marker' };
  if (alias !== undefined) return { ...DEFAULT_ALIASES[alias], source: `alias:${alias}` };
  return null;
}

export function voteFacets(records, hits) {
  const activity = {};
  const topic = {};
  for (const hit of hits) {
    const record = records.find((item) => item.turn === hit.turn);
    if (record === undefined) continue;
    activity[record.facets.activity] = (activity[record.facets.activity] ?? 0) + 1;
    topic[record.facets.topic] = (topic[record.facets.topic] ?? 0) + 1;
  }
  const top = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1])[0] ?? null;
  return { activity: top(activity), topic: top(topic) };
}

export function stabilizeFacets({ raw, text, records, keyword = [], semantic = [], summary = [] }) {
  const facets = { ...raw.facets };
  const confidence = { ...raw.confidence };
  const evidence = voteFacets(records, [...keyword, ...semantic]);
  const summaryEvidence = voteFacets(records, summary);
  const summaryAgrees = evidence.activity !== null
    && summaryEvidence.activity !== null
    && evidence.activity[0] === summaryEvidence.activity[0];
  if (summaryAgrees) evidence.activity[1] += 1;
  const lexical = lexicalFacet(text);

  if (lexical !== null) {
    for (const [slot, value] of Object.entries(lexical)) {
      facets[slot] = value;
      confidence[slot] = 0.9;
    }
    return { facets, confidence, evidence, summaryEvidence, summaryAgrees, reason: lexical.source };
  }

  if ((confidence.activity ?? 0) < 0.7 && evidence.activity !== null && evidence.activity[1] >= 3) {
    facets.activity = evidence.activity[0];
    confidence.activity = 0.65;
  }
  if ((confidence.topic ?? 0) < 0.6 && evidence.topic !== null && evidence.topic[1] >= 3) {
    facets.topic = evidence.topic[0];
  }
  return { facets, confidence, evidence, summaryEvidence, summaryAgrees, reason: 'retrieval' };
}
