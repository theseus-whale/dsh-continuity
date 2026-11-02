/**
 * Main-thread client for the embedding facet worker.
 */
import { Worker } from 'node:worker_threads';

export function createEmbeddingFacetService({ prototypesPath, model, nbModelPath, timeoutMs = 120000 } = {}) {
  if (typeof prototypesPath !== 'string' || prototypesPath.length === 0) {
    throw new Error('embedding service: prototypesPath is required');
  }
  const worker = new Worker(new URL('./embedding-worker.mjs', import.meta.url), {
    workerData: { prototypesPath, model, nbModelPath },
  });
  let nextId = 1;
  const pending = new Map();

  worker.on('message', (message) => {
    const entry = pending.get(message?.id);
    if (entry === undefined) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(message.error));
  });
  worker.on('error', (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  });

  return {
    extract(text) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('embedding service: timeout'));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        worker.postMessage({ id, text: String(text ?? '') });
      });
    },
    async close() {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('embedding service: closed'));
      }
      pending.clear();
      await worker.terminate();
    },
  };
}
