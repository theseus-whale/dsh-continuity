/**
 * JSON store for B+C records and the per-user C map.
 * No model, no network, no LLM.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCMap, deserializeCMap, serializeCMap } from './bc-recall.mjs';

export function defaultBCStorePath(home = process.env.USERPROFILE ?? process.env.HOME ?? os.homedir()) {
  return path.join(home, '.dsh', 'continuity', 'bc-index.jsonl');
}

export function emptyStore() {
  return { version: 1, records: [], cmap: createCMap() };
}

export function loadBCStore(file) {
  if (typeof file !== 'string' || file.length === 0) return emptyStore();
  if (!fs.existsSync(file)) return emptyStore();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    version: Number(raw.version ?? 1),
    records: Array.isArray(raw.records) ? raw.records : [],
    cmap: deserializeCMap(raw.cmap ?? {}),
  };
}

export function saveBCStore(file, store) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  const payload = {
    version: 1,
    records: store.records ?? [],
    cmap: serializeCMap(store.cmap ?? createCMap()),
  };
  fs.writeFileSync(temp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(temp, file);
  return file;
}
