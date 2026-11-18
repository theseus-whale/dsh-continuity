import { sha256 } from './config.mjs';

const normalize = (vector) => {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? vector.slice() : vector.map((value) => value / norm);
};
const cosine = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);

export function createVectorIndex({ config, embedder, records = [] }) {
  const index = {
    model: config.vector.model,
    dimensions: config.vector.dimensions,
    normalize: config.vector.normalize,
    embedder,
    records: [...records],
  };
  index.records = index.records.map((record) => ({ ...record, vector: normalize(record.vector) }));

  async function append(summary) {
    if (index.records.some((record) => record.turnId === summary.turnId)) return null;
    const vector = normalize(await embedder(summary.summaryText, 'document'));
    if (!Array.isArray(vector) || vector.length !== config.vector.dimensions) {
      throw new Error(`turn-ping: embedding dimension ${vector?.length} != ${config.vector.dimensions}`);
    }
    const record = {
      turnId: summary.turnId,
      summarySha256: summary.summarySha256,
      availableCutoff: summary.availableCutoff,
      embeddingModel: config.vector.model,
      dimensions: config.vector.dimensions,
      vector,
      vectorIndexVersion: config.version,
    };
    index.records.push(record);
    return record;
  }

  async function query({ queries, cutoff, limit = config.retrieval.maxCandidatesPerFacet }) {
    const available = index.records.filter((record) => record.availableCutoff <= cutoff);
    const perFacet = [];
    for (const query of queries) {
      const queryVector = normalize(await embedder(config.vector.queryInstruction + query, 'query'));
      const scored = available.map((record) => ({ ...record, score: cosine(queryVector, record.vector) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      perFacet.push({ query, candidates: scored, availableCount: available.length });
    }
    return { perFacet, availableCount: available.length, model: config.vector.model, dimensions: config.vector.dimensions };
  }

  return { append, query, records: () => index.records.map((record) => ({ ...record, vector: record.vector.slice() })), index };
}
