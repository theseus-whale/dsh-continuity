/**
 * Prequential (online) facet learner.
 *
 * At turn t it predicts from examples seen before t, then accepts the true
 * label. No future labels are used.
 */
import { SLOTS, normalizeFacets } from './schema.mjs';

function cosine(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}

export class OnlineFacetKnn {
  constructor({ k = 5, minSimilarity = 0.2, minVote = 0.5 } = {}) {
    this.k = k;
    this.minSimilarity = minSimilarity;
    this.minVote = minVote;
    this.examples = [];
  }

  add(vector, facets) {
    this.examples.push({ vector, facets: normalizeFacets(facets ?? {}) });
  }

  predict(vector) {
    const facets = {};
    const confidence = {};
    for (const slot of SLOTS) {
      const neighbors = this.examples
        .filter((example) => example.facets[slot] !== undefined)
        .map((example) => ({ example, score: cosine(vector, example.vector) }))
        .filter((item) => item.score >= this.minSimilarity)
        .sort((a, b) => b.score - a.score)
        .slice(0, this.k);
      if (neighbors.length === 0) continue;
      const votes = new Map();
      let total = 0;
      for (const item of neighbors) {
        const value = item.example.facets[slot];
        votes.set(value, (votes.get(value) ?? 0) + item.score);
        total += item.score;
      }
      const [value, weight] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
      const vote = total === 0 ? 0 : weight / total;
      if (vote < this.minVote) continue;
      facets[slot] = value;
      confidence[slot] = vote;
    }
    return {
      facets,
      confidence,
      unknown: !Object.keys(facets).some((slot) => slot !== 'random'),
    };
  }
}
