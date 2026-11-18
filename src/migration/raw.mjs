import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

const sha = (value) => createHash('sha256').update(value).digest('hex');

export function decodeRaw(file) {
  const buffer = fs.readFileSync(file);
  if (!file.endsWith('.zstd')) {
    return buffer.toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  }
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  let pos = 0;
  let text = '';
  while (pos < buffer.length) {
    const start = buffer.indexOf(magic, pos);
    if (start < 0) throw new Error('raw: invalid zstd frame boundary');
    const next = buffer.indexOf(magic, start + 4);
    const end = next < 0 ? buffer.length : next;
    text += zlib.zstdDecompressSync(buffer.subarray(start, end)).toString('utf8');
    pos = end;
  }
  return text.split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/^session.*\.jsonl(\.zstd)?$/.test(entry.name)) out.push(full);
  }
}

export function discoverCandidates({ dshHome = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh') } = {}) {
  const files = [];
  walk(path.join(dshHome, 'sessions'), files);
  files.sort();
  const rows = [];
  for (const file of files) {
    let events = null;
    let error = null;
    try { events = decodeRaw(file); } catch (caught) { error = String(caught?.message ?? caught); }
    const header = events?.find((event) => event?.type === 'session') ?? null;
    const sessionId = header?.id ?? path.basename(path.dirname(file));
    const canonical = path.basename(path.dirname(file)) === sessionId && /^session\.v4\.jsonl(\.zstd)?$/.test(path.basename(file));
    rows.push({ sessionId, rawPath: file, canonical, readable: Boolean(header && !error), error, header, events, bytes: fs.statSync(file).size, mtimeMs: fs.statSync(file).mtimeMs });
  }
  return rows;
}

/**
 * Select a current raw for each session. Canonical session.v4 files win.
 * Multiple canonical files are ambiguous unless byte-identical; otherwise fail.
 */
export function selectCandidates(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    const key = String(candidate.sessionId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  const selected = new Map();
  const duplicates = [];
  const anonymous = [];
  for (const [sessionId, rows] of groups) {
    const canonical = rows.filter((row) => row.canonical);
    const pool = canonical.length > 0 ? canonical : rows;
    let chosen = null;
    let reason = null;
    if (pool.length === 1) chosen = pool[0];
    else {
      const hashes = new Set(pool.map((row) => {
        try { return sha(fs.readFileSync(row.rawPath)); } catch { return `error:${row.rawPath}`; }
      }));
      if (hashes.size === 1) chosen = pool[0];
      else reason = canonical.length > 0
        ? 'multiple canonical raw files with different content'
        : 'multiple non-canonical raw files; no canonical current raw';
    }
    const duplicate = rows.length > 1;
    if (duplicate) duplicates.push({ sessionId, count: rows.length, canonicalCount: canonical.length, chosen: chosen?.rawPath ?? null, paths: rows.map((row) => ({ path: row.rawPath, canonical: row.canonical, bytes: row.bytes, mtimeMs: row.mtimeMs })), reason });
    if (!chosen) {
      anonymous.push({ sessionId, count: rows.length, reason, paths: rows.map((row) => row.rawPath) });
      continue;
    }
    selected.set(sessionId, chosen);
  }
  return { selected, duplicates, anonymous };
}

export function discoverSessions({ dshHome } = {}) {
  const candidates = discoverCandidates({ dshHome });
  const { selected, duplicates, anonymous } = selectCandidates(candidates);
  const rows = [...selected.values()].map((row) => ({ sessionId: row.sessionId, rawPath: row.rawPath, readable: row.readable, error: row.error, header: row.header, events: row.events }));
  return Object.assign(rows, { duplicates, anonymous });
}
