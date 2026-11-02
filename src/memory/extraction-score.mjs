/**
 * Entity/slot scoring for extraction benchmarks.
 * Exact span text + label match; no fuzzy matching.
 */
export function scoreEntities(predicted = [], expected = []) {
  const key = (entity) => `${entity.label.toUpperCase()}\u0000${entity.text}`;
  const predictedKeys = new Set(predicted.map(key));
  const expectedKeys = new Set(expected.map(key));
  let tp = 0;
  for (const item of predictedKeys) if (expectedKeys.has(item)) tp += 1;
  const fp = predictedKeys.size - tp;
  const fn = expectedKeys.size - tp;
  const precision = predictedKeys.size === 0 ? 0 : tp / predictedKeys.size;
  const recall = expectedKeys.size === 0 ? 0 : tp / expectedKeys.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    tp,
    fp,
    fn,
    precision: +precision.toFixed(4),
    recall: +recall.toFixed(4),
    f1: +f1.toFixed(4),
  };
}

export function aggregateScores(scores) {
  const total = scores.reduce((acc, score) => ({
    tp: acc.tp + score.tp,
    fp: acc.fp + score.fp,
    fn: acc.fn + score.fn,
  }), { tp: 0, fp: 0, fn: 0 });
  const precision = total.tp + total.fp === 0 ? 0 : total.tp / (total.tp + total.fp);
  const recall = total.tp + total.fn === 0 ? 0 : total.tp / (total.tp + total.fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { ...total, precision: +precision.toFixed(4), recall: +recall.toFixed(4), f1: +f1.toFixed(4) };
}
