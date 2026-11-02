/**
 * Folded range sidecar (~/.dsh/continuity/folds.json).
 *
 * The engine records every compaction it performs: the original shadowed range
 * and the gist summary seq. find/load use this local record to distinguish
 * visible seqs from folded ones without querying the session log.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';

let writeQueue = Promise.resolve();

export function continuityHome() {
  const override = process.env.DSH_CONTINUITY_HOME;
  return override !== undefined && override.length > 0
    ? override
    : join(homedir(), '.dsh', 'continuity');
}

export function foldsFile() {
  return join(continuityHome(), 'folds.json');
}

function normalizeFold(value) {
  const from = Number(value?.from);
  const to = Number(value?.to);
  const gistSeq = Number(value?.gistSeq);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) return null;
  const count = Number(value?.count);
  return {
    from,
    to,
    gistSeq: Number.isInteger(gistSeq) ? gistSeq : null,
    ...(Number.isInteger(count) && count >= 0 ? { count } : {}),
    ...(typeof value?.compactionId === 'string' && value.compactionId ? { compactionId: value.compactionId } : {}),
    at: typeof value?.at === 'string' ? value.at : new Date().toISOString(),
  };
}

/** @returns {Promise<{folds: object[], missing: boolean, corrupt: boolean}>} */
export async function readFolds(sessionId) {
  const id = String(sessionId);
  try {
    const raw = await readFile(foldsFile(), 'utf8');
    const parsed = JSON.parse(raw);
    const session = parsed?.sessions?.[id];
    const folds = Array.isArray(session?.folds)
      ? session.folds.map(normalizeFold).filter(Boolean)
      : [];
    return { folds, missing: false, corrupt: false };
  } catch (error) {
    if (error?.code === 'ENOENT') return { folds: [], missing: true, corrupt: false };
    return { folds: [], missing: false, corrupt: true };
  }
}

/** Append one fold record for a session; serialized and atomic. */
export async function recordFold(sessionId, { from, to, gistSeq, count, compactionId } = {}) {
  const id = String(sessionId);
  const fold = normalizeFold({ from, to, gistSeq, count, compactionId });
  if (fold === null) return null;
  const operation = writeQueue.then(async () => {
    let state = { version: 1, sessions: {} };
    try {
      const raw = await readFile(foldsFile(), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        state = {
          version: 1,
          sessions: parsed.sessions !== null && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)
            ? parsed.sessions
            : {},
        };
      }
    } catch { /* missing/corrupt: start clean */ }
    const session = state.sessions[id] !== null && typeof state.sessions[id] === 'object'
      && !Array.isArray(state.sessions[id])
      ? state.sessions[id]
      : { folds: [] };
    const folds = Array.isArray(session.folds) ? session.folds : [];
    folds.push(fold);
    state.sessions[id] = { folds, updatedAt: new Date().toISOString() };
    const dir = continuityHome();
    await mkdir(dir, { recursive: true });
    const file = foldsFile();
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await rename(temp, file);
    } catch (error) {
      try { await unlink(temp); } catch { /* best effort */ }
      throw new Error(`continuity: cannot write ${file}: ${error?.message ?? error}`);
    }
    return fold;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

/** Latest fold containing seq, or null. */
export function foldForSeq(folds, seq) {
  const number = Number(seq);
  for (let index = (folds?.length ?? 0) - 1; index >= 0; index -= 1) {
    const fold = folds[index];
    if (number >= fold.from && number <= fold.to) return fold;
  }
  return null;
}
