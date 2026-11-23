import { sha256 } from './chunks.mjs';

export const CLUE_NOTE = '摘要仅作定位：按 seq 回读；追溯用原文措辞＋beforeSeq 查更早。无命中≠不存在。';

/**
 * Build a chunk-level ping from active summaries only. No raw-turn rebuild and
 * no per-turn merge: one HIT line per chunk, keyed by chunkId.
 */
export function buildChunkPing({ summaries, scored, cutoff, config }) {
  const active = summaries.filter((summary) => summary.availableCutoff !== null && summary.availableCutoff <= cutoff);
  const byChunk = new Map(active.map((summary) => [summary.chunkId, summary]));
  const hits = [];
  for (const row of scored) {
    const summary = byChunk.get(row.chunkId ?? row.summary?.chunkId);
    if (!summary) continue;
    hits.push(summary);
    if (hits.length >= config.retrieval.maxSummariesPerFacet) break;
  }
  const lines = [];
  for (const summary of hits) {
    lines.push(`- HIT ${summary.chunkId}｜${summary.turnId}｜seq ${summary.seqStart}-${summary.seqEnd}｜${summary.summaryText}`);
  }
  let text = hits.length > 0 ? ['[记忆共振]', ...lines].join('\n') : '';
  let omittedHigh = Math.max(0, scored.length - hits.length);
  if (lines.length > 0) text = `${text}\n\n${CLUE_NOTE}`;
  const limit = config.retrieval.maxPingUtf8Bytes;
  if (Buffer.byteLength(text, 'utf8') > limit) {
    const parts = text.split('\n');
    while (Buffer.byteLength(parts.join('\n'), 'utf8') > limit && parts.length) {
      const removed = parts.pop();
      if (removed?.startsWith('- HIT ')) omittedHigh += 1;
    }
    text = parts.join('\n');
  }
  return { text, bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256(text), clipped: false, omittedHigh, hits };
}
