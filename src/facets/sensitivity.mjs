/**
 * Facet relevance scoring and temporal sensitivity.
 *
 * No LLM. A turn/topic score is an IDF-weighted cosine with a coverage penalty;
 * the temporal series subtracts the corpus baseline so unrelated topics stay
 * near zero.
 */
import { normalizeFacets } from './schema.mjs';

function vectorize(facets) {
  return Object.entries(normalizeFacets(facets ?? {}));
}

export function facetScore(facets, queryFacets, idf) {
  const x = vectorize(facets);
  const q = vectorize(queryFacets);
  if (x.length === 0 || q.length === 0) return { score: 0, coverage: 0, hits: 0 };

  const weight = (slot, value) => idf?.get?.(`${slot}:${value}`) ?? 1;
  const xMap = new Map(x);
  let dot = 0;
  let hits = 0;
  let qNorm = 0;
  let xNorm = 0;
  for (const [slot, value] of q) {
    const w = weight(slot, value);
    qNorm += w * w;
    if (xMap.get(slot) === value) {
      dot += w * w;
      hits += 1;
    }
  }
  for (const [slot, value] of x) {
    const w = weight(slot, value);
    xNorm += w * w;
  }
  if (qNorm === 0 || xNorm === 0) return { score: 0, coverage: 0, hits: 0 };
  const cosine = dot / Math.sqrt(qNorm * xNorm);
  const coverage = hits / q.length;
  return { score: cosine * coverage * coverage, coverage, hits };
}

export function sensitivitySeries(entries, queryFacets, {
  idf = null,
  window = 2,
  weights = [0.5, 0.3, 0.2],
} = {}) {
  const raw = entries.map((entry) => ({
    turn: entry.turn,
    seqStart: entry.seqStart,
    seqEnd: entry.seqEnd,
    time: entry.time ?? null,
    ...facetScore(entry.facets, queryFacets, idf),
  }));
  const baseline = raw.length === 0 ? 0 : raw.reduce((sum, row) => sum + row.score, 0) / raw.length;
  const positive = raw.map((row) => Math.max(0, row.score - baseline));
  const smoothed = positive.map((value, index) => {
    let sum = 0;
    let weightSum = 0;
    for (let k = 0; k <= Math.min(window, index); k += 1) {
      const weight = weights[k] ?? 0;
      sum += positive[index - k] * weight;
      weightSum += weight;
    }
    return weightSum === 0 ? 0 : sum / weightSum;
  });
  return raw.map((row, index) => ({
    ...row,
    baseline,
    positive: positive[index],
    smoothed: smoothed[index],
  }));
}

export function foldPriority(entries, queryFacets, {
  idf = null,
  recentTurns = 20,
  protectScore = 0.5,
} = {}) {
  if (entries.length === 0) return [];
  const latestTurn = Math.max(...entries.map((entry) => entry.turn));
  return entries
    .filter((entry) => entry.turn <= latestTurn - recentTurns)
    .map((entry) => {
      const score = facetScore(entry.facets, queryFacets, idf).score;
      const age = latestTurn - entry.turn;
      return {
        turn: entry.turn,
        seqStart: entry.seqStart,
        seqEnd: entry.seqEnd,
        score,
        protected: score >= protectScore,
        priority: (1 - Math.min(1, score)) * age,
      };
    })
    .filter((entry) => !entry.protected)
    .sort((a, b) => b.priority - a.priority);
}
