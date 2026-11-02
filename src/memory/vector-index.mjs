/**
 * Brute-force vector index for the durable-memory prototype.
 * At 1,462 turns this is exact and cheap; HNSW can replace it later.
 */
import fs from 'node:fs';

function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}

export class VectorIndex {
  constructor() {
    this.docs = [];
  }

  build(records, vectorsByTurn) {
    this.docs = [];
    for (const record of records) {
      const vector = vectorsByTurn.get(record.turn);
      if (vector === undefined) continue;
      this.docs.push({
        turn: record.turn,
        seqStart: record.seqStart,
        seqEnd: record.seqEnd,
        vector,
      });
    }
    return this;
  }

  search(vector, { topK = 20 } = {}) {
    return this.docs
      .map((doc) => ({ ...doc, score: cosine(vector, doc.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  toJSON() {
    return { docs: this.docs };
  }

  static fromJSON(raw) {
    const index = new VectorIndex();
    index.docs = raw.docs;
    return index;
  }
}

export function loadEmbeddings(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return new Map(data.map((row) => [row.turn, row.vector]));
}
