/**
 * BM25 index over the immutable event log.
 */
import { tokenize } from './tokenize.mjs';

export class BM25Index {
  constructor({ k1 = 1.5, b = 0.75 } = {}) {
    this.k1 = k1;
    this.b = b;
    this.docs = [];
    this.postings = new Map();
    this.docLengths = [];
    this.avgLength = 0;
  }

  build(records) {
    this.docs = records.map((record) => ({
      turn: record.turn,
      seqStart: record.seqStart,
      seqEnd: record.seqEnd,
    }));
    this.postings = new Map();
    this.docLengths = [];
    let total = 0;
    records.forEach((record, index) => {
      const tokens = tokenize(record.text);
      this.docLengths[index] = tokens.length;
      total += tokens.length;
      const tf = new Map();
      for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
      for (const [token, count] of tf) {
        if (!this.postings.has(token)) this.postings.set(token, new Map());
        this.postings.get(token).set(index, count);
      }
    });
    this.avgLength = records.length === 0 ? 0 : total / records.length;
    return this;
  }

  search(query, { topK = 20, minCoverage = 0 } = {}) {
    const tokens = [...new Set(tokenize(query))];
    if (tokens.length === 0) return [];
    const scores = new Map();
    const matched = new Map();
    const n = this.docs.length;
    for (const token of tokens) {
      const posting = this.postings.get(token);
      if (posting === undefined) continue;
      const df = posting.size;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      for (const [index, tf] of posting) {
        const dl = this.docLengths[index] || 1;
        const denom = tf + this.k1 * (1 - this.b + this.b * (dl / (this.avgLength || 1)));
        const score = idf * ((tf * (this.k1 + 1)) / denom);
        scores.set(index, (scores.get(index) ?? 0) + score);
        if (!matched.has(index)) matched.set(index, new Set());
        matched.get(index).add(token);
      }
    }
    return [...scores.entries()]
      .map(([index, score]) => ({
        ...this.docs[index],
        score,
        coverage: (matched.get(index)?.size ?? 0) / tokens.length,
      }))
      .filter((hit) => hit.coverage >= minCoverage)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  toJSON() {
    return {
      k1: this.k1,
      b: this.b,
      docs: this.docs,
      docLengths: this.docLengths,
      avgLength: this.avgLength,
      postings: [...this.postings.entries()].map(([token, posting]) => [token, [...posting.entries()]]),
    };
  }

  static fromJSON(raw) {
    const index = new BM25Index({ k1: raw.k1, b: raw.b });
    index.docs = raw.docs;
    index.docLengths = raw.docLengths;
    index.avgLength = raw.avgLength;
    index.postings = new Map(raw.postings.map(([token, entries]) => [token, new Map(entries)]));
    return index;
  }
}

export function mergeRanges(hits) {
  const sorted = [...hits].sort((a, b) => a.seqStart - b.seqStart);
  const ranges = [];
  for (const hit of sorted) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && hit.seqStart <= last.seqEnd + 1) {
      last.seqEnd = Math.max(last.seqEnd, hit.seqEnd);
      last.turns += 1;
      last.lastTurn = hit.turn;
      continue;
    }
    ranges.push({
      seqStart: hit.seqStart,
      seqEnd: hit.seqEnd,
      turns: 1,
      lastTurn: hit.turn,
      score: hit.score,
    });
  }
  return ranges;
}
