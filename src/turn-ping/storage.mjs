import fs from 'node:fs';
import path from 'node:path';

const appendJsonl = async (file, value) => {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.appendFile(file, `${JSON.stringify(value)}\n`, 'utf8');
};
const readJsonl = async (file) => {
  try {
    return (await fs.promises.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
};

export function turnPingRoot({ home, sessionId }) {
  return path.join(home, 'sessions', String(sessionId), 'turn-ping');
}

export function createTurnPingStorage({ home, sessionId }) {
  if (!home) throw new Error('turn-ping storage: home required');
  const root = turnPingRoot({ home, sessionId });
  const summaryFile = path.join(root, 'turn-summaries', 'v1.jsonl');
  const vectorFile = path.join(root, 'vector-index', 'v1', 'records.jsonl');
  const vectorMetaFile = path.join(root, 'vector-index', 'v1', 'meta.json');
  const ledgerFile = path.join(root, 'ledgers', 'turn-ping-v1.jsonl');
  const activePointer = path.join(root, 'activations', 'active.json');
  const activePaths = async () => {
    try {
      const pointer = JSON.parse(await fs.promises.readFile(activePointer, 'utf8'));
      return {
        summaryFile: path.join(root, 'activations', pointer.versionId, 'summaries.jsonl'),
        vectorFile: path.join(root, 'activations', pointer.versionId, 'vectors.jsonl'),
        pointer,
      };
    } catch {
      return { summaryFile, vectorFile, pointer: null };
    }
  };
  return {
    root,
    summaryFile,
    vectorFile,
    vectorMetaFile,
    ledgerFile,
    async summaries() { const paths = await activePaths(); return readJsonl(paths.summaryFile); },
    async vectors() { const paths = await activePaths(); return readJsonl(paths.vectorFile); },
    async appendSummary(summary) {
      const paths = await activePaths();
      const existing = await readJsonl(paths.summaryFile);
      if (existing.some((row) => row.sessionId === summary.sessionId && row.turnId === summary.turnId && row.summarySha256 === summary.summarySha256)) return false;
      await appendJsonl(paths.summaryFile, summary);
      return true;
    },
    async appendVector(record) {
      const paths = await activePaths();
      const existing = await readJsonl(paths.vectorFile);
      if (existing.some((row) => row.turnId === record.turnId && row.summarySha256 === record.summarySha256 && row.vectorIndexVersion === record.vectorIndexVersion)) return false;
      await appendJsonl(paths.vectorFile, record);
      return true;
    },
    async writeVectorMeta(meta) {
      await fs.promises.mkdir(path.dirname(vectorMetaFile), { recursive: true });
      await fs.promises.writeFile(vectorMetaFile, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    },
    async appendLedger(entry) { await appendJsonl(ledgerFile, entry); },
  };
}
