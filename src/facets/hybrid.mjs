/**
 * Hybrid local extractor: Naive Bayes for the learned slots, explicit rules for
 * binary signals that the tiny student model cannot learn from 100 examples.
 */
import { predictFacets } from './classifier.mjs';
import { detectRandom } from './random.mjs';

export function hybridExtractor(model, { minConfidence = 0 } = {}) {
  const threshold = Number(minConfidence) || 0;
  return (text) => {
    const base = predictFacets(model, text);
    const facets = { ...base.facets };
    const confidence = { ...base.confidence };
    const random = detectRandom(text);
    facets.random = random.value;
    confidence.random = random.value === '有' ? 1 : 0.5;
    if (threshold > 0) {
      for (const slot of Object.keys(facets)) {
        if (slot === 'random') continue;
        if ((confidence[slot] ?? 0) < threshold) delete facets[slot];
      }
    }
    return {
      facets,
      confidence,
      unknown: !Object.keys(facets).some((slot) => slot !== 'random'),
    };
  };
}
