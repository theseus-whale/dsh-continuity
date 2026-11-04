/**
 * Compact pointer index: one JSONL line per turn, no raw text.
 * Raw text stays in the session log; the pointer is turn + seq range.
 */
import fs from 'node:fs';
import path from 'node:path';

export function toPointer(record) {
  return {
    turn: record.turn,
    seqStart: record.seqStart,
    seqEnd: record.seqEnd,
    generic: record.generic ?? [],
    ...(Array.isArray(record.genericTopic) ? { genericTopic: record.genericTopic } : {}),
    ...(Array.isArray(record.genericWorkflow) ? { genericWorkflow: record.genericWorkflow } : {}),
    ...(Number.isFinite(record.topicScore) ? { topicScore: record.topicScore } : {}),
    ...(typeof record.topicConfidence === 'string' && record.topicConfidence ? { topicConfidence: record.topicConfidence } : {}),
    ...(Number.isFinite(record.topicMinScore) ? { topicMinScore: record.topicMinScore } : {}),
    labelVersion: Number.isInteger(record.labelVersion) ? record.labelVersion : 1,
    terms: record.terms ?? [],
    keywords: record.keywords ?? [],
    backfilled: record.backfilled ?? [],
    conceptScores: record.conceptScores ?? {},
    confidence: record.confidence ?? 0,
    status: record.status ?? 'weak',
    ...(typeof record.vec === 'string' && record.vec ? { vec: record.vec } : {}),
    ...(Number.isFinite(record.chatter) ? { chatter: Number(record.chatter) } : {}),
    ...(typeof record.sessionId === 'string' && record.sessionId ? { sessionId: record.sessionId } : {}),
  };
}

export function saveIndexJsonl(file, records = []) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, records.map((record) => JSON.stringify(toPointer(record))).join('\n') + (records.length > 0 ? '\n' : ''), 'utf8');
  fs.renameSync(temp, file);
  return file;
}

export function loadIndexJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((line) => {
      const record = JSON.parse(line.replace(/^\uFEFF/, ''));
      return { labelVersion: 1, ...record };
    });
}
