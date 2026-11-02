/**
 * Explicit-delete backups (~/.dsh/continuity/deleted/<id>-<ts>.json).
 * Writes are atomic; nothing here deletes or restores automatically.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';

export function continuityHome() {
  const override = process.env.DSH_CONTINUITY_HOME;
  return override !== undefined && override.length > 0
    ? override
    : join(homedir(), '.dsh', 'continuity');
}

export function deletedDir() {
  return join(continuityHome(), 'deleted');
}

export async function writeDeletedBackup(id, payload) {
  const safe = String(id).replace(/[^a-zA-Z0-9._-]/g, '_');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = deletedDir();
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${safe}-${stamp}.json`);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await rename(temp, file);
  } catch (error) {
    try { await unlink(temp); } catch { /* best effort */ }
    throw new Error(`continuity: cannot write ${file}: ${error?.message ?? error}`);
  }
  return file;
}
