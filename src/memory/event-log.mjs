/**
 * Append-only event log with hash chaining.
 * The log is a normalized projection of an immutable source; it is never
 * rewritten in place after the initial build.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function eventHash(record, prevHash) {
  return sha256(`${prevHash}\n${canonical(record)}`);
}

export function buildEventLog(rows) {
  const records = [];
  let prevHash = 'GENESIS';
  for (const row of [...rows].sort((a, b) => (a.turn - b.turn) || (a.seqStart - b.seqStart))) {
    const body = {
      turn: row.turn,
      seqStart: row.seqStart,
      seqEnd: row.seqEnd,
      text: String(row.text ?? ''),
      facets: row.facets ?? {},
      labelSource: row.labelSource ?? 'unknown',
    };
    const hash = eventHash(body, prevHash);
    records.push({ ...body, prevHash, hash });
    prevHash = hash;
  }
  return records;
}

export function verifyEventLog(records) {
  let prevHash = 'GENESIS';
  const errors = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.prevHash !== prevHash) errors.push({ index, reason: 'prev-hash-mismatch' });
    const expected = eventHash({
      turn: record.turn,
      seqStart: record.seqStart,
      seqEnd: record.seqEnd,
      text: record.text,
      facets: record.facets,
      labelSource: record.labelSource,
    }, prevHash);
    if (expected !== record.hash) errors.push({ index, reason: 'hash-mismatch' });
    prevHash = record.hash;
  }
  return {
    ok: errors.length === 0,
    count: records.length,
    rootHash: records.length === 0 ? 'GENESIS' : records[records.length - 1].hash,
    errors,
  };
}

export function writeEventLog(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  fs.writeFileSync(file, text, 'utf8');
  return { file, bytes: Buffer.byteLength(text), ...verifyEventLog(records) };
}

export function readEventLog(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

export function appendEvent(file, record) {
  const records = fs.existsSync(file) ? readEventLog(file) : [];
  const prevHash = records.length === 0 ? 'GENESIS' : records[records.length - 1].hash;
  const body = {
    turn: record.turn,
    seqStart: record.seqStart,
    seqEnd: record.seqEnd,
    text: String(record.text ?? ''),
    facets: record.facets ?? {},
    labelSource: record.labelSource ?? 'unknown',
  };
  const next = { ...body, prevHash, hash: eventHash(body, prevHash) };
  fs.appendFileSync(file, JSON.stringify(next) + '\n', 'utf8');
  return next;
}
