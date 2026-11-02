/**
 * Facet index + alias query. Pure data; no session reads.
 *
 * entries: [{ turn, seqStart, seqEnd, facets: {slot:value}, unknown }]
 * query:  alias string -> aliasFacets() OR explicit facet object
 */
import { SLOTS, aliasFacets, normalizeFacets } from './schema.mjs';
import { extractFacets } from './extract.mjs';

function facetEntries(facets) {
  return Object.entries(normalizeFacets(facets ?? {}));
}

export function buildFacetIndex(rows, { extract = extractFacets } = {}) {
  const entries = [];
  const df = new Map();
  for (const row of [...rows].sort((a, b) => a.turn - b.turn)) {
    const extracted = row.facets !== undefined
      ? { facets: normalizeFacets(row.facets), evidence: {}, unknown: false }
      : extract(row.text ?? '');
    const facets = extracted.facets ?? {};
    const keys = facetEntries(facets);
    for (const [slot, value] of keys) {
      const key = `${slot}:${value}`;
      df.set(key, (df.get(key) ?? 0) + 1);
    }
    entries.push({
      turn: row.turn,
      seqStart: row.seqStart,
      seqEnd: row.seqEnd,
      facets,
      unknown: extracted.unknown === true || keys.length === 0,
    });
  }
  const total = entries.length;
  const idf = new Map();
  for (const [key, count] of df) {
    idf.set(key, Math.log((1 + total) / (1 + count)) + 1);
  }
  return { entries, idf, total };
}

function resolveQuery(query, index) {
  if (query !== null && typeof query === 'object' && !Array.isArray(query)) {
    return { name: null, facets: normalizeFacets(query) };
  }
  const name = String(query ?? '').trim();
  const facets = aliasFacets(name);
  if (Object.keys(facets).length > 0) return { name, facets };
  const extracted = extractFacets(name);
  return { name, facets: extracted.facets };
}

export function queryFacets(index, query, { topK = 20, minCoverage = 0.6 } = {}) {
  const resolved = resolveQuery(query, index);
  const queryEntries = facetEntries(resolved.facets);
  if (queryEntries.length === 0) return { query: resolved.name, facets: {}, matches: [], ranges: [] };

  const matches = [];
  for (const entry of index.entries) {
    const matchesList = [];
    let idfSum = 0;
    for (const [slot, value] of queryEntries) {
      if (entry.facets[slot] !== value) continue;
      const key = `${slot}:${value}`;
      const weight = index.idf.get(key) ?? 1;
      idfSum += weight;
      matchesList.push(key);
    }
    const coverage = matchesList.length / queryEntries.length;
    if (coverage < minCoverage) continue;
    matches.push({
      turn: entry.turn,
      seqStart: entry.seqStart,
      seqEnd: entry.seqEnd,
      coverage,
      score: idfSum * coverage,
      matched: matchesList,
    });
  }
  matches.sort((a, b) => b.score - a.score || a.turn - b.turn);
  const top = matches.slice(0, Math.max(1, topK));
  const ranges = [];
  for (const hit of top) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && hit.turn === last.lastTurn + 1) {
      last.lastTurn = hit.turn;
      last.seqEnd = Math.max(last.seqEnd, hit.seqEnd);
      last.turns += 1;
    } else {
      ranges.push({ seqStart: hit.seqStart, seqEnd: hit.seqEnd, turns: 1, lastTurn: hit.turn, score: hit.score });
    }
  }
  return {
    query: resolved.name,
    facets: resolved.facets,
    matches: top,
    ranges,
  };
}

export function indexStats(index) {
  const unknown = index.entries.filter((entry) => entry.unknown).length;
  const bySlot = Object.fromEntries(SLOTS.map((slot) => [slot, {}]));
  for (const entry of index.entries) {
    for (const slot of SLOTS) {
      const value = entry.facets[slot];
      if (value === undefined) continue;
      bySlot[slot][value] = (bySlot[slot][value] ?? 0) + 1;
    }
  }
  return { total: index.total, unknown, bySlot };
}
