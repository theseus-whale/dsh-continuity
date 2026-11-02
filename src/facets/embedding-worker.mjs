/**
 * Embedding facet worker. Loads prototypes and the ONNX/WASM embedding model
 * inside worker_threads; the host never blocks on model inference.
 */
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import { deserializePrototypes, fuseFacets, predictEmbedding } from './embedding.mjs';
import { deserializeClassifier } from './classifier.mjs';
import { hybridExtractor } from './hybrid.mjs';

const prototypes = deserializePrototypes(JSON.parse(fs.readFileSync(workerData.prototypesPath, 'utf8')));
const model = workerData.model ?? prototypes.model;
const fallback = workerData.nbModelPath
  ? hybridExtractor(deserializeClassifier(JSON.parse(fs.readFileSync(workerData.nbModelPath, 'utf8'))))
  : null;

parentPort.on('message', async (message) => {
  const id = message?.id;
  try {
    const text = String(message?.text ?? '');
    const embedded = await predictEmbedding(prototypes, text, model);
    const result = fallback === null ? embedded : fuseFacets(embedded, fallback(text));
    parentPort.postMessage({ id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: String(error?.message ?? error) });
  }
});
