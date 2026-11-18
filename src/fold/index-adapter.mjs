import fs from 'node:fs';
import path from 'node:path';
import { turnPingRoot } from '../turn-ping/storage.mjs';
import { loadMergedIndex, writeDelta, activate } from '../fullseed/storage.mjs';

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

/**
 * One writer for turn-ping's two durability formats.
 *
 * Legacy Sonar/fresh sessions store `vector` + `vectorIndexVersion` in the
 * active turn-ping activation directory. Continuity/fullseed sessions store
 * `values` in an immutable base plus deltas and publish a new active pointer.
 * The unified batch never writes one format into the other.
 */
export function createUnifiedIndexAdapter({ home, sessionId, storage, config }) {
  const root = turnPingRoot({ home, sessionId });
  const fullseedRoot = path.join(root, 'fullseed');
  const active = readJson(path.join(fullseedRoot, 'active.json'), null);
  if (active !== null && Array.isArray(active.deltaIds) && active.baseId) {
    const merged = () => loadMergedIndex(fullseedRoot, active);
    return {
      mode: 'fullseed',
      async summaries() {
        return merged().summaries.map((row) => ({ ...row, turnId: row.turnId ?? row.chunkId, chunkId: row.chunkId ?? row.turnId, blockText: row.blockText ?? null, blockSha256: row.blockSha256 ?? null }));
      },
      async vectors() {
        const { summaries, vectors } = merged();
        return vectors.map((values, index) => ({
          turnId: summaries[index]?.turnId,
          chunkId: summaries[index]?.chunkId,
          summarySha256: summaries[index]?.summarySha256,
          dimensions: values.length,
          values,
        }));
      },
      async commitBatch(records, { compactionId, cutoff }) {
        const fresh = records.filter((row) => row.source === 'generated');
        if (fresh.length === 0) return { mode: 'fullseed', deltaId: null };
        const vectors = fresh.map((row) => row.vector);
        if (vectors.some((v) => !v)) throw new Error('unified fold: fullseed batch needs one vector per summary');
        const summaries = fresh.map((row) => ({
          ...row.summary,
          chunkId: row.summary.chunkId ?? row.summary.turnId,
          turnId: row.summary.turnId,
          availableCutoff: row.summary.availableCutoff ?? cutoff,
          blockText: row.summary.blockText,
          blockSha256: row.summary.blockSha256,
        }));
        const deltaId = `fold-${String(compactionId ?? Date.now()).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48)}-${Date.now()}`;
        writeDelta(fullseedRoot, {
          baseId: active.baseId,
          deltaId,
          summaries,
          vectors,
          fromCheckpoint: active.checkpoint ?? null,
          toCheckpoint: cutoff,
          identity: active.identity,
          startOffset: 0,
        });
        // Activation is last: a failed delta write leaves the old active intact.
        activate(fullseedRoot, {
          baseId: active.baseId,
          deltaIds: [...(active.deltaIds ?? []), deltaId],
          identity: active.identity,
          checkpoint: cutoff,
          snapshotBoundary: active.snapshotBoundary ?? null,
          pending: 0,
        });
        return { mode: 'fullseed', deltaId };
      },
      async appendSummary() { throw new Error('unified fold: fullseed adapter uses commitBatch'); },
      async appendVector() { throw new Error('unified fold: fullseed adapter uses commitBatch'); },
      async writeVectorMeta() {},
      async appendLedger(entry) { await storage.appendLedger(entry); },
    };
  }
  return {
    mode: 'legacy',
    summaries: () => storage.summaries(),
    vectors: () => storage.vectors(),
    async commitBatch(records, { cutoff }) {
      for (const row of records) {
        if (row.vector) {
          await storage.appendVector({
            turnId: row.summary.turnId,
            summarySha256: row.summary.summarySha256,
            availableCutoff: row.summary.availableCutoff ?? cutoff,
            embeddingModel: config.vector.model,
            dimensions: row.vector.length,
            vector: row.vector,
            vectorIndexVersion: config.version ?? 'unified-fold-v1',
          });
        }
        if (row.source === 'generated') await storage.appendSummary(row.summary);
      }
      await storage.writeVectorMeta({ indexVersion: `unified-${config.summary.promptVersion}`, model: config.vector.model, dimensions: config.vector.dimensions });
      return { mode: 'legacy' };
    },
    async appendSummary(row) { return storage.appendSummary(row); },
    async appendVector(row) { return storage.appendVector(row); },
    async writeVectorMeta(meta) { return storage.writeVectorMeta(meta); },
    async appendLedger(entry) { return storage.appendLedger(entry); },
  };
}
