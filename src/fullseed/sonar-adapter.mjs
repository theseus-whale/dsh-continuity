import fs from 'node:fs';
import path from 'node:path';

/**
 * Read-only adapter for the existing Sonar v5 activation layout:
 * sessions/<id>/turn-ping/activations/active.json -> <versionId>/summaries.jsonl
 * It never writes or converts the Sonar seed.
 */
export function readSonarSeed(root) {
  const pointerPath = path.join(root, 'activations', 'active.json');
  if (!fs.existsSync(pointerPath)) return { present: false, readOnly: true };
  const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
  const versionDir = path.join(root, 'activations', String(pointer.versionId));
  const summaryPath = path.join(versionDir, 'summaries.jsonl');
  const vectorPath = path.join(versionDir, 'vectors.jsonl');
  const summaries = fs.existsSync(summaryPath)
    ? fs.readFileSync(summaryPath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)
    : [];
  const vectors = fs.existsSync(vectorPath)
    ? fs.readFileSync(vectorPath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)
    : [];
  return {
    present: true,
    readOnly: true,
    versionId: pointer.versionId,
    summaries,
    vectors,
    counts: { summaries: summaries.length, vectors: vectors.length },
    pointer,
  };
}

export function querySonarSeed(root, vector, { cutoff = Infinity, limit = 4 } = {}) {
  const seed = readSonarSeed(root);
  if (!seed.present) return { readOnly: true, hits: [] };
  if (!Array.isArray(vector) || vector.length !== 512) throw new Error('querySonarSeed: 512-dim vector required');
  const bySha = new Map(seed.vectors.map((row) => [row.summarySha256, row]));
  const hits = [];
  for (const summary of seed.summaries) {
    if (Number(summary.availableCutoff) > cutoff) continue;
    const record = bySha.get(summary.summarySha256);
    if (!record) continue;
    let dot = 0; let a = 0; let b = 0;
    for (let i = 0; i < vector.length; i += 1) { dot += vector[i] * record.vector[i]; a += vector[i] ** 2; b += record.vector[i] ** 2; }
    hits.push({ summary, score: dot / Math.sqrt(a * b || 1) });
  }
  hits.sort((x, y) => y.score - x.score);
  return { readOnly: true, hits: hits.slice(0, limit), counts: seed.counts };
}
