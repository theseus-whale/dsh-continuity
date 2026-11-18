import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { eventText, userSourceKind } from './source-view.mjs';

export const RAW_INDEX_VERSION = 'raw-index-v1';
const RAW_INDEX_FILE = 'events.jsonl';
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Only canonical conversation content is indexed; runtime/cue injections are not. */
export function rawIndexRecord(sessionId, event) {
  const seq = Number(event?.seq);
  const type = String(event?.type ?? '');
  if (!Number.isInteger(seq) || seq < 0) return null;
  if (!['user/message', 'assistant/message', 'tool/result'].includes(type)) return null;
  const sourceKind = userSourceKind(event);
  if (type === 'user/message' && !['user', 'peer'].includes(sourceKind)) return null;
  const text = eventText(event);
  if (type === 'tool/result' && /^\[(?:记忆共振|memory_recall)\]/.test(text.trim())) return null;
  if (!text.trim()) return null;
  return {
    version: RAW_INDEX_VERSION,
    sessionId: String(sessionId),
    seq,
    type,
    sourceKind,
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    rawTextSha256: sha256(text),
  };
}

function termsFor(query) {
  const lower = query.toLowerCase();
  const terms = new Set();
  for (const match of lower.matchAll(/[a-z0-9_+#.]+/g)) {
    if (match[0].length >= 2) terms.add(match[0]);
  }
  for (const match of lower.matchAll(/[\u3400-\u9fff\uf900-\ufaff]+/g)) {
    const run = match[0];
    if (run.length === 2) terms.add(run);
    for (let i = 0; i + 1 < run.length; i += 1) terms.add(run.slice(i, i + 2));
  }
  return [...terms];
}

function excerpt(text, at, maxChars = 180) {
  const start = Math.max(0, at - 48);
  const end = Math.min(text.length, start + maxChars);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/[\r\n]+/g, ' ')}${end < text.length ? '…' : ''}`;
}

/**
 * Append-only, rebuildable lexical pointer index. Raw events remain canonical.
 * The index stores full event text so a truncated preview can never hide a hit.
 */
export function createRawIndex({ home, sessionId, diagnosticPath = null }) {
  if (!home) throw new Error('raw index: home required');
  const sid = String(sessionId ?? '');
  if (!sid) throw new Error('raw index: sessionId required');
  const root = path.join(home, 'sessions', sid, 'turn-ping', 'raw-index');
  const file = path.join(root, RAW_INDEX_FILE);
  const diagnostics = diagnosticPath ?? path.join(home, 'turn-ping-prestep-debug.jsonl');
  let records = null;
  let lastReconcile = null;

  function log(kind, detail = {}) {
    const row = { at: new Date().toISOString(), kind, sessionId: sid, ...detail };
    fs.mkdirSync(path.dirname(diagnostics), { recursive: true });
    fs.appendFileSync(diagnostics, `${JSON.stringify(row)}\n`, 'utf8');
  }

  function load() {
    if (records !== null) return records;
    const map = new Map();
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line) continue;
        let row;
        try { row = JSON.parse(line); } catch { throw new Error(`raw index: corrupt JSONL at line ${i + 1}`); }
        if (row?.version !== RAW_INDEX_VERSION || row?.sessionId !== sid || !Number.isInteger(row?.seq)
          || typeof row?.text !== 'string' || row.rawTextSha256 !== sha256(row.text)) {
          throw new Error(`raw index: invalid record at line ${i + 1}`);
        }
        const previous = map.get(row.seq);
        if (previous && previous.rawTextSha256 !== row.rawTextSha256) throw new Error(`raw index: conflicting seq ${row.seq}`);
        map.set(row.seq, row);
      }
    }
    records = map;
    return records;
  }

  function ingest(event) {
    const row = rawIndexRecord(sid, event);
    if (!row) return { indexed: false, reason: 'not-indexable' };
    const map = load();
    const old = map.get(row.seq);
    if (old) {
      if (old.rawTextSha256 !== row.rawTextSha256 || old.type !== row.type) {
        const error = `raw index: canonical event changed at seq ${row.seq}`;
        log('raw-index-conflict', { seq: row.seq });
        throw new Error(error);
      }
      return { indexed: false, duplicate: true, seq: row.seq };
    }
    fs.mkdirSync(root, { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
    map.set(row.seq, row);
    return { indexed: true, seq: row.seq, rawTextSha256: row.rawTextSha256 };
  }

  function rebuild(events) {
    const rows = events.map((event) => rawIndexRecord(sid, event)).filter(Boolean)
      .sort((a, b) => a.seq - b.seq);
    const unique = new Map();
    for (const row of rows) {
      const old = unique.get(row.seq);
      if (old && (old.rawTextSha256 !== row.rawTextSha256 || old.type !== row.type)) {
        throw new Error(`raw index: conflicting raw events at seq ${row.seq}`);
      }
      unique.set(row.seq, row);
    }
    fs.mkdirSync(root, { recursive: true });
    const temporary = path.join(root, `events.${process.pid}.${Date.now()}.tmp`);
    try {
      fs.writeFileSync(temporary, [...unique.values()].map((row) => JSON.stringify(row)).join('\n') + (unique.size ? '\n' : ''), 'utf8');
      fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
    records = unique;
  }

  function reconcile(events = []) {
    let rebuilt = false;
    try { load(); } catch {
      rebuild(events);
      rebuilt = true;
      log('raw-index-rebuilt', { records: records.size });
    }
    let added = 0;
    let duplicates = 0;
    for (const event of events) {
      const result = ingest(event);
      if (result.indexed) added += 1;
      if (result.duplicate) duplicates += 1;
    }
    const indexedSeqs = new Set(load().keys());
    const missingSeqs = events.map((event) => rawIndexRecord(sid, event)).filter(Boolean)
      .map((row) => row.seq).filter((seq) => !indexedSeqs.has(seq));
    lastReconcile = { at: new Date().toISOString(), added, duplicates, missingSeqs, rebuilt };
    if (missingSeqs.length > 0) log('raw-index-missing', { seqs: missingSeqs });
    return lastReconcile;
  }

  function search(query, { limit = 4, beforeSeq = null } = {}) {
    const needle = String(query ?? '').trim().toLowerCase();
    if (needle.length < 2) return [];
    const terms = termsFor(needle);
    const hits = [];
    for (const row of load().values()) {
      if (beforeSeq !== null && row.seq >= beforeSeq) continue;
      const text = row.text.toLowerCase();
      const exactAt = text.indexOf(needle);
      let matchedTerms = 0;
      let firstAt = exactAt;
      for (const term of terms) {
        const at = text.indexOf(term);
        if (at >= 0) {
          matchedTerms += 1;
          if (firstAt < 0 || at < firstAt) firstAt = at;
        }
      }
      const exact = exactAt >= 0;
      // A Latin/identifier term is distinctive; CJK bigrams need two hits.
      const enough = exact || matchedTerms >= 2 || (matchedTerms >= 1 && /[a-z0-9_]/.test(needle));
      if (!enough) continue;
      hits.push({
        sessionId: sid,
        seq: row.seq,
        type: row.type,
        rawTextSha256: row.rawTextSha256,
        bytes: row.bytes,
        score: exact ? 1000 + matchedTerms : matchedTerms / Math.max(1, terms.length),
        excerpt: excerpt(row.text, Math.max(0, firstAt)),
        indexVersion: RAW_INDEX_VERSION,
      });
    }
    hits.sort((a, b) => b.score - a.score || a.seq - b.seq);
    return hits.slice(0, Math.max(1, Math.min(20, Math.trunc(limit) || 4)));
  }

  function status() {
    const map = load();
    return {
      version: RAW_INDEX_VERSION,
      records: map.size,
      lastSeq: map.size ? Math.max(...map.keys()) : null,
      lastReconcile,
      file,
    };
  }

  return { ingest, reconcile, search, status, file };
}

/** Exact raw-hit cue used only when the summary/vector path has no cue. */
export function buildRawIndexPing(hits) {
  if (!Array.isArray(hits) || hits.length === 0) return null;
  const lines = hits.map((hit) => `- 原文 seq=${hit.seq} · ${hit.excerpt}`);
  const text = ['[记忆共振]', ...lines, '以上是原始记录的定位片段；需要完整语义时请核对对应原文。'].join('\n');
  return { text, bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256(text), clipped: false, omittedHigh: 0 };
}
