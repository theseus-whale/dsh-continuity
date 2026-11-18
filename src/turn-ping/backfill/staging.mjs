import fs from 'node:fs';
import path from 'node:path';
import { turnPingRoot } from '../storage.mjs';

const readJsonl = async (file) => {
  try { return (await fs.promises.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
};
const appendJsonl = async (file, value) => {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.appendFile(file, `${JSON.stringify(value)}\n`, 'utf8');
};
const writeJson = async (file, value) => {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.promises.rename(temp, file);
};
const writeJsonl = async (file, rows) => {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(temp, `${rows.map((row) => JSON.stringify(row)).join('\n')}${rows.length ? '\n' : ''}`, 'utf8');
  await fs.promises.rename(temp, file);
};

export function backfillPaths({ home, sessionId, backfillId }) {
  const root = path.join(turnPingRoot({ home, sessionId }), 'backfills', String(backfillId));
  return {
    root,
    stagingDir: path.join(root, 'staging'),
    summaryFile: path.join(root, 'staging', 'turn-summaries.jsonl'),
    vectorFile: path.join(root, 'staging', 'vectors.jsonl'),
    cursorFile: path.join(root, 'cursor.json'),
    ledgerFile: path.join(root, 'ledger.jsonl'),
    manifestFile: path.join(root, 'manifest.json'),
    formalSummaryFile: path.join(turnPingRoot({ home, sessionId }), 'turn-summaries', 'v1.jsonl'),
    formalVectorFile: path.join(turnPingRoot({ home, sessionId }), 'vector-index', 'v1', 'records.jsonl'),
  };
}

export function createBackfillStaging({ home, sessionId, backfillId, checkpoint }) {
  if (!home || !sessionId || !backfillId) throw new Error('backfill staging: home/sessionId/backfillId required');
  const paths = backfillPaths({ home, sessionId, backfillId });
  const stage = {
    paths,
    async summaries() { return readJsonl(paths.summaryFile); },
    async vectors() { return readJsonl(paths.vectorFile); },
    async ledger() { return readJsonl(paths.ledgerFile); },
    async cursor() {
      try { return JSON.parse(await fs.promises.readFile(paths.cursorFile, 'utf8')); }
      catch { return { lastSeq: 0, pending: null }; }
    },
    async appendSummary(summary) {
      const rows = await stage.summaries();
      if (rows.some((row) => row.turnId === summary.turnId)) return false;
      await appendJsonl(paths.summaryFile, summary);
      return true;
    },
    async appendVector(record) {
      const rows = await stage.vectors();
      if (rows.some((row) => row.turnId === record.turnId)) return false;
      await appendJsonl(paths.vectorFile, record);
      return true;
    },
    async appendLedger(entry) { await appendJsonl(paths.ledgerFile, entry); },
    async saveCursor(cursor) { await writeJson(paths.cursorFile, cursor); },
    async writeManifest(manifest) { await writeJson(paths.manifestFile, manifest); },
    async manifest() {
      try { return JSON.parse(await fs.promises.readFile(paths.manifestFile, 'utf8')); }
      catch { return null; }
    },
    async activate({ mode, watermark }) {
      if (!['onfold-formal', 'delta-catchup'].includes(mode)) throw new Error('backfill activation: explicit mode required');
      const stagedSummaries = await stage.summaries();
      const stagedVectors = await stage.vectors();
      const formalSummaries = await readJsonl(paths.formalSummaryFile);
      const formalVectors = await readJsonl(paths.formalVectorFile);
      const byTurn = new Map(formalSummaries.map((row) => [row.turnId, row]));
      for (const row of stagedSummaries) {
        if (byTurn.has(row.turnId) && byTurn.get(row.turnId).summarySha256 !== row.summarySha256) {
          throw new Error(`backfill activation: conflicting formal turn ${row.turnId}`);
        }
        if (!byTurn.has(row.turnId)) { formalSummaries.push(row); byTurn.set(row.turnId, row); }
      }
      const vectorByTurn = new Map(formalVectors.map((row) => [row.turnId, row]));
      for (const row of stagedVectors) {
        if (vectorByTurn.has(row.turnId) && vectorByTurn.get(row.turnId).summarySha256 !== row.summarySha256) {
          throw new Error(`backfill activation: conflicting formal vector ${row.turnId}`);
        }
        if (!vectorByTurn.has(row.turnId)) { formalVectors.push(row); vectorByTurn.set(row.turnId, row); }
      }
      await writeJsonl(paths.formalSummaryFile, formalSummaries);
      await writeJsonl(paths.formalVectorFile, formalVectors);
      await appendJsonl(paths.ledgerFile, { at: new Date().toISOString(), kind: 'activate', mode, watermark });
      return { activated: true, mode, summaries: formalSummaries.length, vectors: formalVectors.length, stagedSummaries: stagedSummaries.length, stagedVectors: stagedVectors.length };
    },
  };
  return stage;
}
