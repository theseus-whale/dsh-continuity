/**
 * Facet panel snapshot and load guidance.
 *
 * Pure data for a future panel/load hook: counts, current alias-facet pairs,
 * a sensitivity curve, and one-line load hints. No UI dependency.
 */
import { DEFAULT_ALIASES, SLOTS, aliasFacets, normalizeFacets } from './schema.mjs';
import { sensitivitySeries } from './sensitivity.mjs';
import { buildFacetIndex, queryFacets } from './index.mjs';

export function buildFacetPanel(entries, {
  idf = null,
  currentAlias = null,
  aliases = DEFAULT_ALIASES,
} = {}) {
  const counts = Object.fromEntries(SLOTS.map((slot) => [slot, {}]));
  let unknown = 0;
  for (const entry of entries) {
    const facets = normalizeFacets(entry.facets ?? {});
    if (Object.keys(facets).length === 0) unknown += 1;
    for (const [slot, value] of Object.entries(facets)) {
      counts[slot][value] = (counts[slot][value] ?? 0) + 1;
    }
  }
  const facetSum = Object.values(counts).reduce((sum, values) => (
    sum + Object.values(values).reduce((a, b) => a + b, 0)
  ), 0);
  const alias = currentAlias !== null && aliases[String(currentAlias)] ? String(currentAlias) : null;
  const query = alias === null ? {} : aliasFacets(alias);
  const series = Object.keys(query).length === 0
    ? []
    : sensitivitySeries(entries, query, { idf });
  return {
    totalTurns: entries.length,
    unknown,
    facetSum,
    counts,
    currentTopic: alias === null ? null : {
      alias,
      facets: query,
      pairs: Object.entries(query).map(([slot, value]) => ({
        slot,
        value,
        turns: counts[slot]?.[value] ?? 0,
      })),
    },
    curve: series,
  };
}

export function buildLoadHint(entries, {
  idf = null,
  query = '跑团',
  recentTurns = 20,
  minScore = 0.2,
  currentTurn = null,
} = {}) {
  const index = idf === null ? buildFacetIndex(entries) : { entries, idf, total: entries.length };
  const result = queryFacets(index, query, { topK: entries.length });
  if (result.matches.length === 0) return null;
  const latestTurn = currentTurn ?? Math.max(...entries.map((entry) => entry.turn));
  const recent = result.matches.filter((hit) => latestTurn - hit.turn <= recentTurns);
  if (recent.length > 0) return null;
  const top = result.matches[0];
  if (top.score < minScore) return null;
  const range = result.ranges[result.ranges.length - 1] ?? null;
  return {
    query,
    text: `[话题线索] ${query}（候选 ${result.ranges.length} 段，最近 seq ${range?.seqStart ?? top.seqStart}–${range?.seqEnd ?? top.seqEnd}，置信 ${top.score.toFixed(2)}）`,
    ranges: result.ranges,
    top,
  };
}
