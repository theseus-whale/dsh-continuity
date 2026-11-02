/**
 * Persistence for facet MVP: index + cursor + residual.
 * JSON files are read/written atomically from the CLI; the pure index remains
 * the source of truth for querying.
 */
import fs from 'node:fs';
import path from 'node:path';

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, text, 'utf8');
  fs.renameSync(temp, file);
}

export function saveIndex(file, index) {
  atomicWrite(file, `${JSON.stringify({
    total: index.total,
    idf: [...index.idf.entries()],
    entries: index.entries,
  }, null, 2)}\n`);
}

export function loadIndex(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    total: Number(raw.total) || 0,
    idf: new Map(Array.isArray(raw.idf) ? raw.idf : []),
    entries: Array.isArray(raw.entries) ? raw.entries : [],
  };
}

export function saveCursor(file, cursor) {
  atomicWrite(file, `${JSON.stringify(cursor, null, 2)}\n`);
}

export function loadCursor(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
