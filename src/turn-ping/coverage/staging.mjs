import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createBackfillStaging, backfillPaths } from '../backfill/staging.mjs';
import { turnPingRoot } from '../storage.mjs';

const readJsonl = async (file) => {
  try { return (await fs.promises.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
  catch { return []; }
};
const writeJsonl = async (file, rows) => {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(temp, `${rows.map((row) => JSON.stringify(row)).join('\n')}${rows.length ? '\n' : ''}`, 'utf8');
  await fs.promises.rename(temp, file);
};
const sha = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

export function createCoverageStaging({ home, sessionId, coverageId, checkpoint }) {
  if (!sessionId) throw new Error('coverage staging: sessionId required');
  const staging = createBackfillStaging({ home, sessionId, backfillId: coverageId, checkpoint });
  const root = turnPingRoot({ home, sessionId });
  const activationRoot = path.join(root, 'activations');
  const activePointer = path.join(activationRoot, 'active.json');
  const current = async () => {
    try {
      const pointer = JSON.parse(await fs.promises.readFile(activePointer, 'utf8'));
      return {
        pointer,
        summaries: await readJsonl(path.join(activationRoot, pointer.versionId, 'summaries.jsonl')),
        vectors: await readJsonl(path.join(activationRoot, pointer.versionId, 'vectors.jsonl')),
      };
    } catch {
      return { pointer: null, summaries: await readJsonl(staging.paths.formalSummaryFile), vectors: await readJsonl(staging.paths.formalVectorFile) };
    }
  };
  return {
    ...staging,
    coverageId,
    async activate(args = {}) {
      const watermark = args?.watermark;
      if (!watermark || watermark.ok !== true) throw new Error('coverage activation: verified watermark required');
      if (Array.isArray(watermark.errors) && watermark.errors.length > 0) throw new Error('coverage activation: watermark errors present');
      if (watermark.pending !== undefined && Number(watermark.pending) !== 0) throw new Error('coverage activation: pending coverage remains');
      const stagedSummaries = await staging.summaries();
      const stagedVectors = await staging.vectors();
      if (stagedSummaries.length === 0) throw new Error('coverage activation: empty summary staging');
      if (stagedVectors.length === 0) throw new Error('coverage activation: empty vector staging');
      if (watermark.eligible !== undefined && stagedSummaries.length < Number(watermark.eligible)) {
        throw new Error('coverage activation: staged summaries do not cover eligible set');
      }
      if (watermark.covered !== undefined && Number(watermark.covered) !== stagedSummaries.length) {
        throw new Error('coverage activation: covered count mismatch');
      }
      const byTurn = new Map(stagedSummaries.map((row) => [row.turnId, row]));
      for (const vector of stagedVectors) {
        const summary = byTurn.get(vector.turnId);
        if (!summary) throw new Error(`coverage activation: orphan staged vector ${vector.turnId}`);
        if (summary.summarySha256 !== vector.summarySha256) throw new Error(`coverage activation: summary/vector mismatch ${vector.turnId}`);
      }
      const base = await current();
      const summaries = [...base.summaries];
      const summaryByTurn = new Map(summaries.map((row) => [row.turnId, row]));
      for (const row of stagedSummaries) {
        const existing = summaryByTurn.get(row.turnId);
        if (existing && existing.summarySha256 !== row.summarySha256) throw new Error(`coverage activation: conflict ${row.turnId}`);
        if (!existing) { summaries.push(row); summaryByTurn.set(row.turnId, row); }
      }
      const vectors = [...base.vectors];
      const vectorByTurn = new Map(vectors.map((row) => [row.turnId, row]));
      for (const row of stagedVectors) {
        const existing = vectorByTurn.get(row.turnId);
        if (existing && existing.summarySha256 !== row.summarySha256) throw new Error(`coverage activation: vector conflict ${row.turnId}`);
        if (!existing) { vectors.push(row); vectorByTurn.set(row.turnId, row); }
      }
      const versionId = `${Date.now()}-${sha(JSON.stringify({ coverageId, summaries, vectors })).slice(0, 16)}`;
      const versionSummaryFile = path.join(activationRoot, versionId, 'summaries.jsonl');
      const versionVectorFile = path.join(activationRoot, versionId, 'vectors.jsonl');
      await writeJsonl(versionSummaryFile, summaries);
      await writeJsonl(versionVectorFile, vectors);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (typeof args.beforeCommit === 'function') await args.beforeCommit({ versionId });
        const latest = await current();
        let changed = false;
        for (const row of latest.summaries) {
          const existing = summaryByTurn.get(row.turnId);
          if (existing && existing.summarySha256 !== row.summarySha256) throw new Error(`coverage activation: concurrent summary conflict ${row.turnId}`);
          if (!existing) { summaries.push(row); summaryByTurn.set(row.turnId, row); changed = true; }
        }
        for (const row of latest.vectors) {
          const existing = vectorByTurn.get(row.turnId);
          if (existing && existing.summarySha256 !== row.summarySha256) throw new Error(`coverage activation: concurrent vector conflict ${row.turnId}`);
          if (!existing) { vectors.push(row); vectorByTurn.set(row.turnId, row); changed = true; }
        }
        if (!changed) break;
        await writeJsonl(versionSummaryFile, summaries);
        await writeJsonl(versionVectorFile, vectors);
      }
      const pointer = { versionId, activatedAt: new Date().toISOString(), mode: args.mode, coverageId, summaryCount: summaries.length, vectorCount: vectors.length };
      const temp = `${activePointer}.${process.pid}.${Date.now()}.tmp`;
      await fs.promises.mkdir(path.dirname(activePointer), { recursive: true });
      await fs.promises.writeFile(temp, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8');
      await fs.promises.rename(temp, activePointer);
      await staging.appendLedger({ at: new Date().toISOString(), kind: 'activate', mode: args.mode, watermark, pointer });
      return { activated: true, mode: args.mode, ...pointer, stagedSummaries: stagedSummaries.length, stagedVectors: stagedVectors.length };
    },
    async activePointer() {
      try { return JSON.parse(await fs.promises.readFile(activePointer, 'utf8')); } catch { return null; }
    },
    paths: { ...staging.paths, ...backfillPaths({ home, sessionId, backfillId: coverageId }), activationRoot, activePointer },
  };
}
