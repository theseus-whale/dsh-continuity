/**
 * Tiny local facet classifier (multinomial Naive Bayes over char bigrams).
 *
 * This is the "small model" seam: it learns from accepted facet labels and can
 * be replaced by an ONNX embedding/SetFit model later without changing the
 * index/query API. No external dependency.
 */
import { SLOTS, VALUES, normalizeFacets } from './schema.mjs';

const ALPHA = 1;

function tokens(text) {
  const source = String(text ?? '').toLowerCase();
  const out = [];
  const words = source.match(/[a-z0-9_]+/g) ?? [];
  for (const word of words) out.push(`w:${word}`);
  for (const chunk of source.match(/[\u4e00-\u9fff]+/g) ?? []) {
    const chars = [...chunk];
    for (let i = 0; i < chars.length; i += 1) {
      out.push(`c:${chars[i]}`);
      if (i + 1 < chars.length) out.push(`b:${chars[i]}${chars[i + 1]}`);
    }
  }
  return [...new Set(out)].slice(0, 800);
}

export function trainFacetClassifier(rows) {
  const model = { version: 1, slots: {}, vocab: new Set() };
  for (const slot of SLOTS) {
    model.slots[slot] = {
      docs: 0,
      values: Object.fromEntries(VALUES[slot].map((value) => [value, { docs: 0, tokens: new Map(), total: 0 }])),
    };
  }
  for (const row of rows) {
    const facets = normalizeFacets(row.facets ?? {});
    const list = tokens(row.text);
    for (const token of list) model.vocab.add(token);
    for (const slot of SLOTS) {
      const value = facets[slot];
      if (value === undefined) continue;
      const bucket = model.slots[slot];
      const cell = bucket.values[value];
      bucket.docs += 1;
      cell.docs += 1;
      for (const token of list) {
        cell.tokens.set(token, (cell.tokens.get(token) ?? 0) + 1);
        cell.total += 1;
      }
    }
  }
  model.vocab = [...model.vocab];
  return model;
}

export function predictFacets(model, text) {
  const list = tokens(text);
  const facets = {};
  const confidence = {};
  for (const slot of SLOTS) {
    const bucket = model.slots?.[slot];
    if (!bucket || bucket.docs === 0) continue;
    const vocabSize = Math.max(1, model.vocab?.length ?? 1);
    const scored = [];
    for (const value of VALUES[slot]) {
      const cell = bucket.values[value];
      if (!cell || cell.docs === 0) continue;
      let score = Math.log((cell.docs + ALPHA) / (bucket.docs + ALPHA * VALUES[slot].length));
      const denom = cell.total + ALPHA * vocabSize;
      for (const token of list) {
        const count = cell.tokens.get(token) ?? 0;
        score += Math.log((count + ALPHA) / denom);
      }
      scored.push({ value, score });
    }
    scored.sort((a, b) => b.score - a.score);
    if (scored.length === 0) continue;
    const top = scored[0];
    const second = scored[1];
    const margin = second === undefined ? 1 : top.score - second.score;
    if (margin < 0.2) continue;
    facets[slot] = top.value;
    confidence[slot] = Math.min(1, margin / 2);
  }
  return { facets, confidence, unknown: Object.keys(facets).length === 0 };
}

export function evaluate(model, rows) {
  const report = {};
  for (const slot of SLOTS) {
    let total = 0;
    let correct = 0;
    let covered = 0;
    for (const row of rows) {
      const truth = normalizeFacets(row.facets ?? {})[slot];
      if (truth === undefined) continue;
      total += 1;
      const predicted = predictFacets(model, row.text).facets[slot];
      if (predicted === undefined) continue;
      covered += 1;
      if (predicted === truth) correct += 1;
    }
    report[slot] = {
      total,
      covered,
      correct,
      coverage: total === 0 ? 0 : covered / total,
      accuracy: covered === 0 ? 0 : correct / covered,
    };
  }
  return report;
}

export function classifierExtractor(model) {
  return (text) => predictFacets(model, text);
}

export function serializeClassifier(model) {
  const slots = {};
  for (const [slot, bucket] of Object.entries(model.slots ?? {})) {
    slots[slot] = {
      docs: bucket.docs,
      values: Object.fromEntries(Object.entries(bucket.values).map(([value, cell]) => [value, {
        docs: cell.docs,
        total: cell.total,
        tokens: [...cell.tokens.entries()],
      }])),
    };
  }
  return { version: 1, vocab: model.vocab ?? [], slots };
}

export function deserializeClassifier(raw) {
  const model = { version: 1, vocab: Array.isArray(raw?.vocab) ? raw.vocab : [], slots: {} };
  for (const [slot, bucket] of Object.entries(raw?.slots ?? {})) {
    model.slots[slot] = {
      docs: Number(bucket.docs) || 0,
      values: Object.fromEntries(Object.entries(bucket.values ?? {}).map(([value, cell]) => [value, {
        docs: Number(cell.docs) || 0,
        total: Number(cell.total) || 0,
        tokens: new Map(Array.isArray(cell.tokens) ? cell.tokens : []),
      }])),
    };
  }
  return model;
}
