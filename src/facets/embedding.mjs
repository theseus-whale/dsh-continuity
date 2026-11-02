/**
 * Local embedding prototypes for facets.
 *
 * Uses transformers.js (ONNX/WASM) with a multilingual small embedding model.
 * The model is downloaded once into the local HF cache; no text leaves the
 * machine. Prototypes are built from accepted facet labels.
 */
import { SLOTS, VALUES, normalizeFacets } from './schema.mjs';
import { detectRandom } from './random.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let extractorPromise = null;
const MODEL_ID = 'Xenova/bge-small-zh-v1.5';
const LOCAL_MODELS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../models');

export async function loadEmbedder(model = MODEL_ID) {
  if (extractorPromise !== null) return extractorPromise;
  const { pipeline, env } = await import('@huggingface/transformers');
  const localConfig = path.join(LOCAL_MODELS, model, 'config.json');
  if (fs.existsSync(localConfig)) {
    env.allowRemoteModels = false;
    env.localModelPath = LOCAL_MODELS;
  } else {
    env.allowRemoteModels = true;
    env.remoteHost = process.env.FACET_HF_ENDPOINT || 'https://hf-mirror.com';
  }
  extractorPromise = pipeline('feature-extraction', model, { dtype: 'q8' });
  return extractorPromise;
}

export async function embedTexts(texts, model) {
  const extractor = await loadEmbedder(model);
  const output = await extractor(texts, { pooling: 'mean', normalize: true });
  return output.tolist();
}

function normalizeVector(vector) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

function average(vectors) {
  if (vectors.length === 0) return [];
  const dims = vectors[0].length;
  const sum = new Array(dims).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < dims; i += 1) sum[i] += vector[i];
  }
  return normalizeVector(sum.map((value) => value / vectors.length));
}

function cosine(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}

export async function buildEmbeddingPrototypes(rows, model) {
  const source = rows.filter((row) => row.text && row.facets);
  const vectors = await embedTexts(source.map((row) => row.text), model);
  const slots = {};
  for (const slot of SLOTS) {
    slots[slot] = { values: {} };
    for (const value of VALUES[slot]) {
      const selected = [];
      source.forEach((row, index) => {
        if (normalizeFacets(row.facets)[slot] === value) selected.push(vectors[index]);
      });
      if (selected.length > 0) slots[slot].values[value] = average(selected);
    }
  }
  return { model, slots };
}

export async function predictEmbedding(prototypes, text, model) {
  const [vector] = await embedTexts([text], model ?? prototypes.model);
  const facets = {};
  const confidence = {};
  for (const slot of SLOTS) {
    let best = null;
    let second = null;
    for (const [value, centroid] of Object.entries(prototypes.slots?.[slot]?.values ?? {})) {
      const score = cosine(vector, centroid);
      if (best === null || score > best.score) {
        second = best;
        best = { value, score };
      } else if (second === null || score > second.score) {
        second = { value, score };
      }
    }
    if (best === null) continue;
    const margin = second === null ? 1 : best.score - second.score;
    if (margin < 0.01) continue;
    facets[slot] = best.value;
    confidence[slot] = margin;
  }
  const random = detectRandom(text);
  facets.random = random.value;
  confidence.random = random.value === '有' ? 1 : 0.5;
  return {
    facets,
    confidence,
    unknown: !Object.keys(facets).some((slot) => slot !== 'random'),
  };
}

export function embeddingExtractor(prototypes, model) {
  return async (text) => predictEmbedding(prototypes, text, model);
}

export function serializePrototypes(prototypes) {
  return {
    model: prototypes.model,
    slots: Object.fromEntries(Object.entries(prototypes.slots ?? {}).map(([slot, bucket]) => [slot, {
      values: Object.fromEntries(Object.entries(bucket.values ?? {})),
    }])),
  };
}

export function deserializePrototypes(raw) {
  return {
    model: raw?.model,
    slots: Object.fromEntries(Object.entries(raw?.slots ?? {}).map(([slot, bucket]) => [slot, {
      values: Object.fromEntries(Object.entries(bucket.values ?? {})),
    }])),
  };
}

/**
 * Slot-aware fusion: embedding wins only where it is calibrated; participants
 * stays with the local NB because embedding prototypes overfit that slot.
 */
export function fuseFacets(embedding, fallback, {
  embeddingSlots = ['activity', 'interaction', 'medium', 'topic'],
} = {}) {
  const facets = { ...fallback.facets };
  const confidence = { ...fallback.confidence };
  for (const slot of embeddingSlots) {
    if (embedding?.facets?.[slot] === undefined) continue;
    facets[slot] = embedding.facets[slot];
    confidence[slot] = embedding.confidence?.[slot] ?? 0;
  }
  if (embedding?.facets?.random !== undefined) facets.random = embedding.facets.random;
  return {
    facets,
    confidence,
    unknown: !Object.keys(facets).some((slot) => slot !== 'random'),
  };
}

