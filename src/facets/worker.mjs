/**
 * Facet worker: loads a serialized local small model and answers extract
 * requests off the host main thread.
 */
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import { deserializeClassifier } from './classifier.mjs';
import { hybridExtractor } from './hybrid.mjs';

const raw = JSON.parse(fs.readFileSync(workerData.modelPath, 'utf8'));
const model = deserializeClassifier(raw);
const extract = hybridExtractor(model);

parentPort.on('message', (message) => {
  const id = message?.id;
  try {
    const text = String(message?.text ?? '');
    const result = extract(text);
    parentPort.postMessage({ id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: String(error?.message ?? error) });
  }
});
