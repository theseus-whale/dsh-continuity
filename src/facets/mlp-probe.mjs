/**
 * Frozen BGE + per-slot MLP head, exported from sklearn.
 * Two dense layers with ReLU; output softmax.
 */
export function deserializeMlp(raw) {
  return {
    slots: Object.fromEntries(Object.entries(raw?.slots ?? {}).map(([slot, value]) => [slot, {
      classes: value.classes,
      w1: value.w1,
      b1: value.b1,
      w2: value.w2,
      b2: value.b2,
    }])),
  };
}

function relu(value) {
  return value > 0 ? value : 0;
}

function softmax(scores) {
  const max = Math.max(...scores);
  const exp = scores.map((score) => Math.exp(score - max));
  const sum = exp.reduce((a, b) => a + b, 0) || 1;
  return exp.map((value) => value / sum);
}

export function predictMlp(model, vector) {
  const facets = {};
  const confidence = {};
  for (const [slot, slotModel] of Object.entries(model.slots)) {
    const hidden = new Array(slotModel.b1.length);
    for (let h = 0; h < hidden.length; h += 1) {
      let sum = slotModel.b1[h];
      for (let d = 0; d < vector.length; d += 1) sum += slotModel.w1[d][h] * vector[d];
      hidden[h] = relu(sum);
    }
    const scores = slotModel.classes.map((_, c) => {
      let sum = slotModel.b2[c];
      for (let h = 0; h < hidden.length; h += 1) sum += slotModel.w2[h][c] * hidden[h];
      return sum;
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
