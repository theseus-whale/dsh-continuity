import fs from 'node:fs';
import path from 'node:path';
import { buildRawChunks, verifyChunk } from '../fullseed/chunks.mjs';
import { loadActiveIndex } from '../fullseed/cache.mjs';
import { verifyArtifact } from '../fullseed/storage.mjs';
import { createTurnPingHost } from '../turn-ping/host.mjs';
import { createBgeEmbedder } from '../turn-ping/host-adapters.mjs';
import { createCanonicalReadRawChunkTool } from '../fullseed/read-raw-chunk-canonical.mjs';

export async function verifyMigration({ plan, query, embedder = null }) {
  if (!plan?.storageRoot) throw new Error('verify: plan storageRoot missing');
  const rawEvents = (await import('./raw.mjs')).decodeRaw(plan.raw.path);
  const chunks = buildRawChunks(plan.sessionId, rawEvents, { checkpointSeq: plan.checkpoint }).chunks;
  const bySeq = new Map(rawEvents.map((event) => [Number(event.seq), event]));
  const chunkBy = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
  const errors = [];
  if (chunks.length !== plan.chunkSet.count) errors.push('chunk count');
  if (!chunks.every((chunk) => verifyChunk(chunk, bySeq))) errors.push('raw offsets');
  const active = JSON.parse(fs.readFileSync(path.join(plan.storageRoot, 'active.json'), 'utf8'));
  if (active.pending !== 0) errors.push('active pending');
  if (active.checkpoint !== plan.checkpoint) errors.push('active checkpoint');
  if (active.identity !== plan.identity) errors.push('active identity');
  if (typeof active.baseId !== 'string' || !Array.isArray(active.deltaIds)) errors.push('active base/delta shape');
  const artifacts = [];
  if (active.baseId) artifacts.push({ kind: 'base', id: active.baseId, dir: path.join(plan.storageRoot, 'bases', active.baseId) });
  for (const deltaId of active.deltaIds ?? []) artifacts.push({ kind: 'delta', id: deltaId, dir: path.join(plan.storageRoot, 'bases', active.baseId, 'deltas', deltaId) });
  let artifactSummaries = 0;
  let artifactVectors = 0;
  for (const artifact of artifacts) {
    try {
      const manifest = verifyArtifact(artifact.dir);
      if (manifest.identity !== plan.identity) errors.push(`${artifact.kind} identity ${artifact.id}`);
      if (artifact.kind === 'base' && active.deltaIds.length === 0 && manifest.checkpoint !== plan.checkpoint) errors.push('base checkpoint');
      if (artifact.kind === 'delta' && manifest.toCheckpoint !== plan.checkpoint) errors.push(`delta checkpoint ${artifact.id}`);
      artifactSummaries += manifest.summaries;
      artifactVectors += manifest.vectors;
    } catch (error) {
      errors.push(`${artifact.kind} artifact ${artifact.id}: ${error?.message ?? error}`);
    }
  }
  const index = loadActiveIndex(plan.storageRoot);
  if (!index) throw new Error('verify: active index missing');
  if (artifactSummaries !== index.merged.summaries.length) errors.push('base+delta summary count');
  if (artifactVectors !== index.merged.vectors.length) errors.push('base+delta vector count');
  if (index.merged.summaries.length !== chunks.length) errors.push('summary count');
  if (index.merged.vectors.length !== chunks.length) errors.push('vector count');
  const reusable = new Set((plan.reusableItems ?? []).map((item) => item.chunkId));
  const seen = new Set();
  for (const summary of index.merged.summaries) {
    const chunk = chunkBy.get(summary.chunkId);
    if (!chunk) { errors.push(`orphan ${summary.chunkId}`); continue; }
    if (seen.has(summary.chunkId)) errors.push(`duplicate summary ${summary.chunkId}`);
    seen.add(summary.chunkId);
    if (summary.rawTextSha256 !== chunk.rawTextSha256 || summary.seqStart !== chunk.seqStart || summary.seqEnd !== chunk.seqEnd) errors.push(`raw mismatch ${summary.chunkId}`);
    if (!Number.isInteger(summary.availableCutoff) || summary.availableCutoff <= 0 || summary.availableCutoff > plan.checkpoint) errors.push(`cutoff ${summary.chunkId}`);
    else if (!reusable.has(summary.chunkId) && summary.availableCutoff !== plan.checkpoint) errors.push(`new-item cutoff ${summary.chunkId}`);
  }
  if (seen.size !== chunks.length) errors.push('summary coverage');
  const dshHome = plan.storageRoot.includes(`${path.sep}continuity${path.sep}sessions${path.sep}`)
    ? plan.storageRoot.slice(0, plan.storageRoot.indexOf(`${path.sep}continuity${path.sep}sessions${path.sep}`))
    : null;
  if (!dshHome) throw new Error('verify: cannot derive continuity home');
  const host = createTurnPingHost({ home: path.join(dshHome, 'continuity'), config: { enabled: true, boundaries: { allowDefaultEnable: true } }, embedder: embedder ?? createBgeEmbedder({ model: './models/Xenova/bge-small-zh-v1.5' }) });
  const answer = await host.beforeAnswer({ sessionId: plan.sessionId, query: String(query ?? ''), cutoff: plan.checkpoint });
  const hit = answer?.retrieval?.chunks?.[0]?.summary;
  let raw = null;
  if (hit) {
    const tool = createCanonicalReadRawChunkTool({
      resolveSessionQuery: () => ({ readSession: async () => ({ events: rawEvents }) }),
      resolveRoot: () => plan.storageRoot,
      allowedSessionIds: new Set([plan.sessionId]),
    });
    raw = JSON.parse(await tool.execute({ chunkId: hit.chunkId, byteOffset: 0, maxBytes: 4096 }, { agent: { session: { id: plan.sessionId } } }));
  }
  return { ok: errors.length === 0 && Boolean(hit), errors, chunks: chunks.length, active, query: { H: answer?.H ?? null, hit: hit?.chunkId ?? null, pingSha256: answer?.ping?.sha256 ?? null }, raw };
}
