import { selectNovelHits } from './quiet.mjs';

const normalize = (vector) => {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? vector.slice() : vector.map((value) => value / norm);
};
const cosine = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);

export function disclosureCount(H, { maxPerFacet = 4 } = {}) {
  if (!Number.isFinite(H) || H <= 0) return 0;
  return Math.min(maxPerFacet, Math.ceil(Math.sqrt(H)));
}

export function highScore(candidates, config) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const top = candidates[0].score;
  const threshold = Math.max(config.retrieval.tau, top - config.retrieval.delta);
  return candidates.filter((candidate) => candidate.score >= threshold);
}

export function splitUnits(query, maxUnits = 64) {
  const text = String(query ?? '');
  if (!text.trim()) return [];
  const units = text.split(/[。；;\n]+/).map((unit) => unit.trim()).filter(Boolean);
  return units.length === 0 ? [text.trim()] : units;
}

/**
 * Deterministic merge before faceting: every character of every unit is kept.
 * Merge the adjacent pair with the smallest combined length; ties go left.
 */
export function mergeUnitsToLimit(units, maxUnits) {
  const merged = units.map((text, index) => ({ text, indexes: [index] }));
  while (merged.length > maxUnits) {
    let best = 0;
    let bestLength = Infinity;
    for (let index = 0; index < merged.length - 1; index += 1) {
      const length = merged[index].text.length + merged[index + 1].text.length;
      if (length < bestLength) { best = index; bestLength = length; }
    }
    const left = merged[best];
    const right = merged[best + 1];
    merged.splice(best, 2, { text: `${left.text}；${right.text}`, indexes: [...left.indexes, ...right.indexes] });
  }
  return merged;
}

function componentsFor(vectors, threshold) {
  const parent = vectors.map((_, index) => index);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[rb] = ra; };
  for (let i = 0; i < vectors.length; i += 1) {
    for (let j = i + 1; j < vectors.length; j += 1) {
      if (cosine(vectors[i], vectors[j]) >= threshold) union(i, j);
    }
  }
  const groups = new Map();
  vectors.forEach((_, index) => {
    const root = find(index);
    const list = groups.get(root) ?? [];
    list.push(index);
    groups.set(root, list);
  });
  return [...groups.values()].map((indexes) => indexes.sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);
}

/**
 * One facet pass: rule split -> batch embeddings -> similarity graph
 * connected components -> at most maxFacets. Failure/no-embedder degrades to
 * a single Vector query; it never calls a topic LLM and never silently drops units.
 */
export async function buildFacets({ query, embedder, config }) {
  const units = splitUnits(query, config.retrieval.maxUnits);
  if (units.length === 0) return { facets: [], fallback: false, unitCount: 0 };
  if (units.length === 1 || typeof embedder !== 'function') {
    return { facets: [{ index: 0, text: units.join('；'), unitIndexes: [0] }], fallback: units.length > 1, unitCount: units.length };
  }
  const merged = mergeUnitsToLimit(units, config.retrieval.maxUnits);
  let vectors;
  try {
    vectors = await Promise.all(merged.map((unit) => embedder(unit.text, 'query')));
    if (vectors.some((vector) => !Array.isArray(vector) || vector.length !== vectors[0].length)) throw new Error('facet embedding dimension mismatch');
    vectors = vectors.map(normalize);
  } catch {
    return { facets: [{ index: 0, text: merged.map((unit) => unit.text).join('；'), unitIndexes: merged.flatMap((unit) => unit.indexes) }], fallback: true, unitCount: units.length, error: 'facet-embedding-failed' };
  }
  let groups = componentsFor(vectors, config.retrieval.facetSimilarityThreshold);
  while (groups.length > config.retrieval.maxFacets) {
    const left = groups.shift();
    const right = groups.shift();
    groups.unshift([...left, ...right].sort((a, b) => a - b));
  }
  const facets = groups.map((indexes, facetIndex) => ({
    index: facetIndex,
    text: indexes.map((index) => merged[index].text).join('；'),
    unitIndexes: indexes.flatMap((index) => merged[index].indexes),
  }));
  return { facets, fallback: false, unitCount: units.length, mergedUnitCount: merged.length };
}

/**
 * Fair allocation: one slot to every facet first, then distribute the
 * remaining global budget by remaining desired slots. Omitted facets are explicit.
 */
export function allocateFacets(facets, config) {
  const cap = config.retrieval.maxSummariesGlobal;
  const selected = facets.map((facet) => ({ ...facet, show: 0 }));
  let budget = cap;
  for (const facet of selected) {
    if (budget > 0 && facet.desired > 0) { facet.show = 1; budget -= 1; }
  }
  while (budget > 0) {
    const candidates = selected.filter((facet) => facet.show < facet.desired);
    if (candidates.length === 0) break;
    candidates.sort((a, b) => (b.desired - b.show) - (a.desired - a.show) || b.H - a.H || a.index - b.index);
    candidates[0].show += 1;
    budget -= 1;
  }
  const omissions = selected.filter((facet) => facet.show < facet.desired).map((facet) => ({
    index: facet.index,
    H: facet.H,
    desired: facet.desired,
    show: facet.show,
    omitted: facet.desired - facet.show,
  }));
  return { facets: selected.filter((facet) => facet.show > 0), omissions };
}

export async function retrieve({ query, cutoff, index, config, quiet = null }) {
  const facetResult = await buildFacets({ query, embedder: index.embedder, config });
  const { perFacet, availableCount } = await index.query({ queries: facetResult.facets.map((facet) => facet.text), cutoff });
  const selectedVectors = quiet ? quiet.referenceVectors.map(vector => [...vector]) : [];
  const facets = perFacet.map((facet, indexKey) => {
    let high = highScore(facet.candidates, config);
    if (quiet) {
      high = high.filter(candidate => !quiet.referenceIds.has(candidate.turnId));
      high = selectNovelHits(high, selectedVectors, quiet.noveltyThreshold);
      for (const hit of high) selectedVectors.push(hit.vector);
    }
    return { index: indexKey, query: facet.query, high, H: high.length, desired: disclosureCount(high.length) };
  }).filter((facet) => facet.H > 0);
  const allocation = allocateFacets(facets, config);
  return { availableCount, facets: allocation.facets, omissions: allocation.omissions, facetFallback: facetResult.fallback, tau: config.retrieval.tau, delta: config.retrieval.delta, quiet: Boolean(quiet) };
}
