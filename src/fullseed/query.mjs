import fs from 'node:fs';
import path from 'node:path';

const QUERY_INSTRUCTION = '为这个句子生成表示以用于检索相关文章：';

export function loadCachedIndex(root, active) {
  const base = path.join(root, 'bases', active.baseId);
  const summaries = fs.readFileSync(path.join(base, 'summaries.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const records = fs.readFileSync(path.join(base, 'vector-records.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const buf = fs.readFileSync(path.join(base, 'vectors.f32'));
  const vectors = records.map((r) => Array.from(new Float32Array(buf.buffer, buf.byteOffset + r.offset, r.dimensions)));
  return { summaries, records, vectors };
}

export async function queryIndex({ index, embedder, query, limit = 8 }) {
  const input = `${QUERY_INSTRUCTION}${query}`;
  const q = await embedder(input);
  if (!Array.isArray(q) || q.length !== (index.vectors[0]?.length ?? q.length) || !q.every(Number.isFinite)) throw new Error('invalid query vector');
  const scored = index.vectors.map((vector, i) => {
    let dot = 0;
    let a = 0;
    let b = 0;
    for (let j = 0; j < q.length; j += 1) { dot += q[j] * vector[j]; a += q[j] * q[j]; b += vector[j] * vector[j]; }
    return { summary: index.summaries[i], score: dot / Math.sqrt(a * b || 1) };
  }).sort((left, right) => right.score - left.score).slice(0, limit);
  return scored;
}
