/**
 * True incremental facet learners.
 * All consume one labelled turn at a time; no batch retraining.
 */
import { SLOTS, normalizeFacets } from './schema.mjs';

function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}

function softmax(scores) {
  const max = Math.max(...scores);
  const exp = scores.map((score) => Math.exp(score - max));
  const sum = exp.reduce((a, b) => a + b, 0) || 1;
  return exp.map((value) => value / sum);
}

function result(facets, confidence) {
  return {
    facets,
    confidence,
    unknown: !Object.keys(facets).some((slot) => slot !== 'random'),
  };
}

/** Running mean per facet value, cosine nearest centroid. */
export class OnlineCentroid {
  constructor({ minSimilarity = 0.15 } = {}) {
    this.minSimilarity = minSimilarity;
    this.state = Object.fromEntries(SLOTS.map((slot) => [slot, new Map()]));
  }

  predict(vector) {
    const facets = {};
    const confidence = {};
    for (const slot of SLOTS) {
      let best = null;
      for (const [value, cell] of this.state[slot]) {
        if (cell.count === 0) continue;
        const centroid = cell.sum.map((x) => x / cell.count);
        const score = cosine(vector, centroid);
        if (best === null || score > best.score) best = { value, score };
      }
      if (best === null || best.score < this.minSimilarity) continue;
      facets[slot] = best.value;
      confidence[slot] = best.score;
    }
    return result(facets, confidence);
  }

  update(vector, facets) {
    for (const [slot, value] of Object.entries(normalizeFacets(facets ?? {}))) {
      let cell = this.state[slot].get(value);
      if (cell === undefined) {
        cell = { count: 0, sum: new Array(vector.length).fill(0) };
        this.state[slot].set(value, cell);
      }
      cell.count += 1;
      for (let i = 0; i < vector.length; i += 1) cell.sum[i] += vector[i];
    }
  }
}

/** Running mean + diagonal variance, Gaussian-like score. */
export class OnlineCentroidVariance {
  constructor({ minSimilarity = 0.1, varianceWeight = 0.5 } = {}) {
    this.minSimilarity = minSimilarity;
    this.varianceWeight = varianceWeight;
    this.state = Object.fromEntries(SLOTS.map((slot) => [slot, new Map()]));
  }

  predict(vector) {
    const facets = {};
    const confidence = {};
    for (const slot of SLOTS) {
      let best = null;
      for (const [value, cell] of this.state[slot]) {
        if (cell.count < 2) continue;
        let dot = 0;
        let dist = 0;
        for (let i = 0; i < vector.length; i += 1) {
          const mean = cell.sum[i] / cell.count;
          const variance = Math.max(1e-6, cell.sumsq[i] / cell.count - mean * mean);
          dot += vector[i] * mean;
          dist += ((vector[i] - mean) ** 2) / variance;
        }
        const score = dot - this.varianceWeight * (dist / vector.length);
        if (best === null || score > best.score) best = { value, score };
      }
      if (best === null || best.score < this.minSimilarity) continue;
      facets[slot] = best.value;
      confidence[slot] = best.score;
    }
    return result(facets, confidence);
  }

  update(vector, facets) {
    for (const [slot, value] of Object.entries(normalizeFacets(facets ?? {}))) {
      let cell = this.state[slot].get(value);
      if (cell === undefined) {
        cell = {
          count: 0,
          sum: new Array(vector.length).fill(0),
          sumsq: new Array(vector.length).fill(0),
        };
        this.state[slot].set(value, cell);
      }
      cell.count += 1;
      for (let i = 0; i < vector.length; i += 1) {
        cell.sum[i] += vector[i];
        cell.sumsq[i] += vector[i] * vector[i];
      }
    }
  }
}

function tokens(text) {
  const raw = String(text ?? '').toLowerCase();
  const words = raw.match(/[a-z0-9_]+/g) ?? [];
  const chinese = [...raw.replace(/[^\u4e00-\u9fff]/g, '')];
  const bigrams = [];
  for (let i = 0; i + 1 < chinese.length; i += 1) bigrams.push(chinese[i] + chinese[i + 1]);
  return [...words, ...bigrams];
}

/** Multinomial Naive Bayes with additive smoothing. */
export class OnlineNaiveBayes {
  constructor({ alpha = 1 } = {}) {
    this.alpha = alpha;
    this.state = Object.fromEntries(SLOTS.map((slot) => [slot, new Map()]));
    this.prior = Object.fromEntries(SLOTS.map((slot) => [slot, new Map()]));
    this.total = Object.fromEntries(SLOTS.map((slot) => [slot, 0]));
  }

  predict(text) {
    const t = tokens(text);
    const facets = {};
    const confidence = {};
    for (const slot of SLOTS) {
      if (this.total[slot] === 0) continue;
      let best = null;
      for (const [value, docs] of this.prior[slot]) {
        let score = Math.log((docs + this.alpha) / (this.total[slot] + this.alpha * this.prior[slot].size));
        const counts = this.state[slot].get(value);
        let tokenTotal = 0;
        for (const count of counts.values()) tokenTotal += count;
        for (const token of t) {
          score += Math.log(((counts.get(token) ?? 0) + this.alpha) / (tokenTotal + this.alpha * counts.size));
        }
        if (best === null || score > best.score) best = { value, score };
      }
      if (best === null) continue;
      facets[slot] = best.value;
      confidence[slot] = best.score;
    }
    return result(facets, confidence);
  }

  update(text, facets) {
    for (const [slot, value] of Object.entries(normalizeFacets(facets ?? {}))) {
      if (!this.prior[slot].has(value)) {
        this.prior[slot].set(value, 0);
        this.state[slot].set(value, new Map());
      }
      this.prior[slot].set(value, this.prior[slot].get(value) + 1);
      this.total[slot] += 1;
      const counts = this.state[slot].get(value);
      for (const token of tokens(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
}

/** One-pass online softmax regression. */
export class OnlineSoftmax {
  constructor({ classes, dim, learningRate = 0.02 } = {}) {
    this.classes = classes;
    this.dim = dim;
    this.learningRate = learningRate;
    this.weights = new Map();
    this.bias = new Map();
  }

  ensure(value) {
    if (!this.weights.has(value)) {
      this.weights.set(value, new Array(this.dim).fill(0));
      this.bias.set(value, 0);
    }
  }

  predict(vector) {
    if (this.classes.length === 0) return result({}, {});
    const scores = this.classes.map((value) => {
      this.ensure(value);
      const weights = this.weights.get(value);
      let sum = this.bias.get(value);
      for (let i = 0; i < vector.length; i += 1) sum += weights[i] * vector[i];
      return sum;
    });
    const probs = softmax(scores);
    let best = 0;
    for (let i = 1; i < probs.length; i += 1) if (probs[i] > probs[best]) best = i;
    return result({ activity: this.classes[best] }, { activity: probs[best] });
  }

  update(vector, facets) {
    const truth = normalizeFacets(facets ?? {});
    if (truth.activity === undefined) return;
    this.ensure(truth.activity);
    const scores = this.classes.map((value) => {
      this.ensure(value);
      const weights = this.weights.get(value);
      let sum = this.bias.get(value);
      for (let i = 0; i < vector.length; i += 1) sum += weights[i] * vector[i];
      return sum;
    });
    const probs = softmax(scores);
    for (let c = 0; c < this.classes.length; c += 1) {
      const value = this.classes[c];
      const gradient = probs[c] - (value === truth.activity ? 1 : 0);
      const weights = this.weights.get(value);
      for (let i = 0; i < vector.length; i += 1) weights[i] -= this.learningRate * gradient * vector[i];
      this.bias.set(value, this.bias.get(value) - this.learningRate * gradient);
    }
  }
}
