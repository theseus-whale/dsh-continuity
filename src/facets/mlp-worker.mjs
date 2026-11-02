/**
 * MLP facet worker: BGE embedding + per-slot MLP in worker_threads.
 */
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import { embedTexts } from './embedding.mjs';
import { deserializeMlp, predictMlp } from './mlp-probe.mjs';
import { detectRandom } from './random.mjs';

const model = deserializeMlp(JSON.parse(fs.readFileSync(workerData.modelPath, 'utf8')));
const embeddingModel = workerData.embeddingModel;

parentPort.on('message', async (message) => {
  const id = message?.id;
  try {
    const text = String(message?.text ?? '');
    const [vector] = await embedTexts([text], embeddingModel);
    const result = predictMlp(model, vector);
    result.facets.random = detectRandom(text).value;
    if (result.facets.participants === undefined) result.facets.participants = '协作';
    result.unknown = !Object.keys(result.facets).some((slot) => slot !== 'random');
    parentPort.postMessage({ id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: String(error?.message ?? error) });
  }
});
