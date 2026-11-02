/**
 * Frozen-embedding linear probe.
 * Weights are exported from a local logistic-regression training run.
 */
export function deserializeLinearProbe(raw) {
  return {
    slots: Object.fromEntries(Object.entries(raw?.slots ?? {}).map(([slot, value]) => [slot, {
      classes: value.classes,
      coef: value.coef,
      intercept: value.intercept,
    }])),
  };
}

function softmax(scores) {
  const max = Math.max(...scores);
  const exp = scores.map((score) => Math.exp(score - max));
  const sum = exp.reduce((a, b) => a + b, 0) || 1;
  return exp.map((value) => value / sum);
}

export function predictLinearProbe(model, vector) {
  const facets = {};
  const confidence = {};
  for (const [slot, slotModel] of Object.entries(model.slots)) {
    const scores = slotModel.classes.map((_, classIndex) => {
      let value = slotModel.intercept[classIndex] ?? 0;
      const coef = slotModel.coef[classIndex];
      for (let i = 0; i < vector.length; i += 1) value += coef[i] * vector[i];
      return value;
    });
    const probs = softmax(scores);
    let best = 0;
    for (let i = 1; i < probs.length; i += 1) if (probs[i] > probs[best]) best = i;
    facets[slot] = slotModel.classes[best];
    confidence[slot] = probs[best];
  }
  return {
    facets,
    confidence,
    unknown: !Object.keys(facets).some((slot) => slot !== 'random'),
  };
}
