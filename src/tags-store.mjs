/**
 * Durable Continuity tag sidecar (~/.dsh/continuity/tags.json).
 *
 * Missing is a valid empty state (all T0). Corrupt JSON also falls back to the
 * empty state instead of throwing; callers record one warning. Writes are
 * serialized and atomic. Raw session events are never touched.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { emptyTags, normalizeTags } from './tags.mjs';

let writeQueue = Promise.resolve();

export function continuityHome() {
  const override = process.env.DSH_CONTINUITY_HOME;
  return override !== undefined && override.length > 0
    ? override
    : join(homedir(), '.dsh', 'continuity');
}

export function tagsFile(home = continuityHome()) {
  return join(home, 'tags.json');
}

export function tagsMdFile(home = continuityHome()) {
  return join(home, 'tags.md');
}

/** Write the generated tags.md view (never read back by the plugin). */
export async function writeTagsMd(text, home = continuityHome()) {
  const dir = home;
  await mkdir(dir, { recursive: true });
  const file = tagsMdFile(home);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, String(text ?? ''), 'utf8');
    await rename(temp, file);
  } catch (error) {
    try { await unlink(temp); } catch { /* best effort */ }
    throw new Error(`continuity: cannot write ${file}: ${error?.message ?? error}`);
  }
}

/**
 * @returns {Promise<{state: object, missing: boolean, corrupt: boolean, error: string|null}>}
 */
export async function readTags(home = continuityHome()) {
  try {
    const raw = await readFile(tagsFile(home), 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { state: emptyTags(), missing: false, corrupt: true, error: error?.message ?? String(error) };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { state: emptyTags(), missing: false, corrupt: true, error: 'tags.json must contain an object' };
    }
    return { state: normalizeTags(parsed), missing: false, corrupt: false, error: null };
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: emptyTags(), missing: true, corrupt: false, error: null };
    return { state: emptyTags(), missing: false, corrupt: true, error: error?.message ?? String(error) };
  }
}

async function writeTags(state, home = continuityHome()) {
  const dir = home;
  await mkdir(dir, { recursive: true });
  const file = tagsFile(home);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temp, file);
  } catch (error) {
    try { await unlink(temp); } catch { /* best effort */ }
    throw new Error(`continuity: cannot write ${file}: ${error?.message ?? error}`);
  }
}

/** Serialized read-modify-write. The mutator receives a normalized copy. */
export async function updateTags(mutate, home = continuityHome()) {
  const operation = writeQueue.then(async () => {
    const read = await readTags(home);
    const working = structuredClone(read.state);
    const next = await mutate(working);
    const value = next !== null && next !== undefined && typeof next === 'object' ? next : working;
    const normalized = normalizeTags({ ...value, updatedAt: new Date().toISOString() });
    await writeTags(normalized, home);
    return { state: normalized, recovered: read.missing || read.corrupt, readError: read.error };
  });
  writeQueue = operation.catch(() => {});
  return operation;
}
