import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildRawChunks, verifyChunk } from '../fullseed/chunks.mjs';
import { loadActiveIndex } from '../fullseed/cache.mjs';
import { readSonarSeed } from '../fullseed/sonar-adapter.mjs';
import { discoverCandidates, selectCandidates, discoverSessions, decodeRaw } from './raw.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');

function roots({ dshHome, sessionId }) {
  const turnPing = path.join(dshHome, 'continuity', 'sessions', sessionId, 'turn-ping');
  return { turnPing, legacy: turnPing, fullseed: path.join(turnPing, 'fullseed') };
}

export function auditSession({ dshHome, sessionId, rawPath = null }) {
  if (!sessionId) throw new Error('audit: session id required');
  const all = discoverCandidates({ dshHome });
  const selected = selectCandidates(all);
  const duplicate = selected.duplicates.find((row) => row.sessionId === String(sessionId)) ?? null;
  const unresolved = selected.anonymous.find((row) => row.sessionId === String(sessionId)) ?? null;
  const chosen = rawPath ? { sessionId, rawPath, readable: true } : selected.selected.get(String(sessionId));
  if (!chosen) {
    return {
      sessionId,
      raw: { readable: false, error: unresolved?.reason ?? 'raw not found' },
      issues: [{ kind: unresolved ? 'duplicate-ambiguous' : 'raw-missing', detail: unresolved?.reason ?? 'raw not found' }],
      duplicates: duplicate,
      canPlan: false,
    };
  }
  const match = rawPath
    ? { sessionId, rawPath, readable: true, events: null }
    : selected.selected.get(String(sessionId)) ?? null;
  const actual = rawPath ? { rawPath, events: null } : match;
  let events;
  let rawError = null;
  try { events = actual.events ?? decodeRaw(actual.rawPath); } catch (error) { rawError = String(error?.message ?? error); }
  if (!events) {
    return { sessionId, raw: { path: actual.rawPath, readable: false, error: rawError ?? 'unreadable' }, issues: [{ kind: 'raw-unreadable', detail: rawError ?? 'unreadable' }], duplicates: duplicate, canPlan: false };
  }
  const header = events.find((event) => event?.type === 'session') ?? null;
  if (!header || String(header.id) !== String(sessionId)) {
    return { sessionId, raw: { path: actual.rawPath, readable: false, error: 'session header missing/mismatch', events: events.length }, issues: [{ kind: 'schema-unknown', detail: 'session header missing/mismatch' }], duplicates: duplicate, canPlan: false };
  }
  const lastSeq = Number(events.at(-1)?.seq);
  const checkpoint = Number.isInteger(lastSeq) ? lastSeq + 1 : null;
  if (!Number.isInteger(checkpoint) || checkpoint <= 0) {
    return { sessionId, raw: { path: actual.rawPath, readable: false, events: events.length, lastSeq }, issues: [{ kind: 'checkpoint-invalid' }], duplicates: duplicate, canPlan: false };
  }
  const { chunks } = buildRawChunks(String(sessionId), events, { checkpointSeq: checkpoint });
  const bySeq = new Map(events.map((event) => [Number(event.seq), event]));
  const chunkErrors = [];
  for (const chunk of chunks) {
    try { if (!verifyChunk(chunk, bySeq)) chunkErrors.push(chunk.chunkId); } catch (error) { chunkErrors.push(`${chunk.chunkId}:${error?.message ?? error}`); }
  }
  const { legacy, fullseed } = roots({ dshHome, sessionId });
  const legacySeed = readSonarSeed(legacy);
  const legacyIssues = [];
  for (const summary of legacySeed.summaries ?? []) {
    if (typeof summary.chunkId !== 'string') legacyIssues.push({ kind: 'legacy-schema', seqStart: summary.seqStart, seqEnd: summary.seqEnd });
    const chunk = chunks.find((row) => row.seqStart === summary.seqStart && row.seqEnd === summary.seqEnd && row.rawTextSha256 === summary.rawTextSha256);
    if (!chunk) legacyIssues.push({ kind: 'legacy-raw-mismatch', seqStart: summary.seqStart, seqEnd: summary.seqEnd });
    const vector = (legacySeed.vectors ?? []).find((row) => row.turnId === summary.turnId && row.summarySha256 === summary.summarySha256);
    if (!vector || (Array.isArray(vector.vector) && vector.vector.length !== 512)) legacyIssues.push({ kind: 'legacy-vector-schema', turnId: summary.turnId });
  }
  const fullseedIndex = loadActiveIndex(fullseed);
  const fullseedSummaries = fullseedIndex?.merged?.summaries ?? [];
  const fullseedVectors = fullseedIndex?.merged?.vectors ?? [];
  const fullseedIssues = [];
  const reusableItems = [];
  const used = new Set();
  for (let i = 0; i < fullseedSummaries.length; i += 1) {
    const summary = fullseedSummaries[i];
    const chunk = chunks.find((row) => row.chunkId === summary.chunkId);
    if (!chunk) { fullseedIssues.push({ kind: 'fullseed-orphan-summary', chunkId: summary.chunkId }); continue; }
    if (summary.rawTextSha256 !== chunk.rawTextSha256 || summary.seqStart !== chunk.seqStart || summary.seqEnd !== chunk.seqEnd) {
      fullseedIssues.push({ kind: 'fullseed-raw-mismatch', chunkId: summary.chunkId });
      continue;
    }
    if (typeof summary.summaryText !== 'string' || summary.summaryText.trim().length === 0) {
      fullseedIssues.push({ kind: 'fullseed-summary-empty', chunkId: summary.chunkId });
      continue;
    }
    if (summary.summarySha256 !== sha(summary.summaryText)) {
      fullseedIssues.push({ kind: 'fullseed-summary-sha-mismatch', chunkId: summary.chunkId });
      continue;
    }
    if (!Number.isInteger(summary.availableCutoff) || summary.availableCutoff <= 0 || summary.availableCutoff > checkpoint) {
      fullseedIssues.push({ kind: 'fullseed-cutoff-invalid', chunkId: summary.chunkId });
      continue;
    }
    const vector = fullseedVectors[i];
    if (!Array.isArray(vector) || vector.length !== 512 || !vector.every(Number.isFinite)) {
      fullseedIssues.push({ kind: 'fullseed-vector-schema', chunkId: summary.chunkId });
      continue;
    }
    used.add(summary.chunkId);
    reusableItems.push({
      chunkId: summary.chunkId,
      summarySha256: summary.summarySha256,
      cohort: 'fullseed',
      source: 'fullseed-active',
      availableCutoff: summary.availableCutoff,
      rawTextSha256: chunk.rawTextSha256,
      seqStart: chunk.seqStart,
      seqEnd: chunk.seqEnd,
    });
  }
  const missingItems = chunks.filter((chunk) => !used.has(chunk.chunkId)).map((chunk) => ({
    chunkId: chunk.chunkId,
    turnId: chunk.turnId,
    chunkIndex: chunk.chunkIndex,
    seqStart: chunk.seqStart,
    seqEnd: chunk.seqEnd,
    rawTextSha256: chunk.rawTextSha256,
    bytes: chunk.bytes,
    chars: chunk.chars,
  }));
  const issues = [
    ...chunkErrors.map((chunkId) => ({ kind: 'chunk-raw-verification', chunkId })),
    ...legacyIssues,
    ...fullseedIssues,
  ];
  const legacyActivePath = path.join(legacy, 'activations', 'active.json');
  const fullseedActivePath = path.join(fullseed, 'active.json');
  return {
    sessionId,
    raw: { path: actual.rawPath, readable: true, bytes: fs.statSync(actual.rawPath).size, events: events.length, lastSeq, checkpoint },
    chunks: {
      count: chunks.length,
      sha256: sha(chunks.map((chunk) => chunk.chunkId).sort().join('\n')),
      first: chunks[0]?.chunkId ?? null,
      last: chunks.at(-1)?.chunkId ?? null,
      rawErrors: chunkErrors.length,
    },
    existing: {
      legacy: { present: legacySeed.present === true, summaries: legacySeed.counts?.summaries ?? 0, vectors: legacySeed.counts?.vectors ?? 0 },
      fullseed: { present: Boolean(fullseedIndex), summaries: fullseedSummaries.length, vectors: fullseedVectors.length },
    },
    reusable: reusableItems.length,
    missing: missingItems.length,
    reusableItems,
    missingItems,
    issues,
    duplicates: duplicate,
    active: {
      legacy: { path: legacyActivePath, sha256: fs.existsSync(legacyActivePath) ? sha(fs.readFileSync(legacyActivePath)) : null, preserved: true },
      fullseed: { path: fullseedActivePath, sha256: fs.existsSync(fullseedActivePath) ? sha(fs.readFileSync(fullseedActivePath)) : null, preserved: true },
    },
    canPlan: chunkErrors.length === 0 && chunks.length > 0,
  };
}

export function auditAll({ dshHome }) {
  const candidates = discoverCandidates({ dshHome });
  const selection = selectCandidates(candidates);
  const rows = [];
  for (const row of selection.selected.values()) {
    try { rows.push(auditSession({ dshHome, sessionId: row.sessionId })); }
    catch (error) { rows.push({ sessionId: row.sessionId, raw: { path: row.rawPath, readable: false, error: String(error?.message ?? error) }, canPlan: false }); }
  }
  for (const unresolved of selection.anonymous) {
    rows.push({ sessionId: unresolved.sessionId, raw: { readable: false, error: unresolved.reason }, duplicates: unresolved, issues: [{ kind: 'duplicate-ambiguous', detail: unresolved.reason }], canPlan: false });
  }
  return { rows, duplicates: selection.duplicates, unreadable: selection.anonymous };
}
