import fs from 'node:fs';
import path from 'node:path';
import { buildRawChunks } from './chunks.mjs';
import { loadActiveIndex } from './cache.mjs';
import { runSeed, buildIdentity, appendIncrement } from './seed.mjs';
import { groupTurnEvents } from '../turn-ping/turn-groups.mjs';

const QUEUE = 'increment-queue.jsonl';

export function enqueueTurnStopping({ root, sessionId, turn, at = new Date().toISOString() }) {
  const token = turn && typeof turn === 'object' ? turn.turn ?? turn.id ?? JSON.stringify(turn) : turn;
  if (sessionId === undefined || token === undefined || token === null) return { enqueued: false, reason: 'session/turn-required' };
  fs.mkdirSync(root, { recursive: true });
  const queueId = `${sessionId}:${JSON.stringify(token)}`;
  const duplicate = readQueue(root).some((row) => row.queueId === queueId && ['pending', 'done'].includes(row.status));
  if (duplicate) return { enqueued: false, duplicate: true, queueId };
  fs.appendFileSync(path.join(root, QUEUE), `${JSON.stringify({ sessionId, turn, at, status: 'pending', queueId })}\n`, 'utf8');
  return { enqueued: true, queueId };
}

export function readQueue(root) {
  const file = path.join(root, QUEUE);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

export function installEngineTurnStopping({ ctx, root, rootForSession = null, sessionIdOf = (agent) => agent?.session?.id ?? agent?.sessionId ?? ctx?.session?.id, allowedSessionIds = null }) {
  if (!ctx || typeof ctx.on !== 'function') throw new Error('fullseed hook: ctx.on required');
  return ctx.on('agent/turn-stopping', async ({ agent, turn } = {}) => {
    const sessionId = sessionIdOf(agent ?? ctx);
    if (!sessionId || (allowedSessionIds && !allowedSessionIds.has(String(sessionId)))) return { enqueued: false };
    const sessionRoot = rootForSession ? rootForSession(sessionId) : root;
    const queued = enqueueTurnStopping({ root: sessionRoot, sessionId, turn });
    return { ...queued, sessionId, turn, providerCalls: 0 };
  });
}

export function completedTurnsAfter(events, watermark) {
  const ordered = [...events].sort((a, b) => Number(a.seq) - Number(b.seq));
  if (ordered.some((event) => event?.type === 'turn/start')) {
    return groupTurnEvents(ordered)
      .filter((group) => group.closed && group.start > watermark)
      .map((group) => ({ start: group.start, end: group.hostEnd, turnEndSeq: group.hostEnd }));
  }
  const boundaries = ordered.filter((e) => e?.type === 'user/message'
    && ['user', 'peer'].includes(e?.data?.message?.source?.kind ?? e?.data?.source?.kind));
  const turnEnds = ordered.filter((e) => e?.type === 'turn/end');
  const out = [];
  for (let i = 0; i < boundaries.length; i += 1) {
    const start = Number(boundaries[i].seq);
    if (start <= watermark) continue;
    const next = i + 1 < boundaries.length ? Number(boundaries[i + 1].seq) : null;
    if (next !== null) { out.push({ start, end: next - 1, turnEndSeq: null }); continue; }
    const endEvent = turnEnds.filter((e) => Number(e.seq) > start).at(-1);
    if (endEvent) out.push({ start, end: Number(endEvent.seq), turnEndSeq: Number(endEvent.seq) });
  }
  return out;
}

/** Async increment: consume completed turns only, write one delta, activate atomically. */
export async function processIncrement({
  root, sessionId, events, watermark, provider, embedder, identity, maxAttempts = 2,
}) {
  if (!Number.isInteger(watermark)) throw new Error('processIncrement: watermark required');
  const hostMode = events.some((event) => event?.type === 'turn/start');
  const completedGroups = hostMode
    ? groupTurnEvents(events).filter((group) => group.closed && group.start > watermark)
    : null;
  const completed = hostMode
    ? completedGroups.map((group) => ({ start: group.start, end: group.hostEnd, turnEndSeq: group.hostEnd }))
    : completedTurnsAfter(events, watermark);
  if (completed.length === 0) return { chunks: 0, delta: null, active: null };
  const checkpoint = completed.at(-1).end;
  const relevant = hostMode
    ? completedGroups.flatMap((group) => group.events)
    : events.filter((e) => Number(e.seq) > watermark && Number(e.seq) <= checkpoint);
  const { chunks } = buildRawChunks(sessionId, relevant, { checkpointSeq: checkpoint + 1 });
  if (chunks.length === 0) return { chunks: 0, delta: null, active: null };
  const seed = await runSeed({
    chunks, root, provider, embedder, maxAttempts, identity, deferBase: true,
    checkpoint, snapshotBoundary: checkpoint,
  });
  if (seed.pending !== 0) throw new Error('processIncrement: incomplete staging');
  // Read the pointer again after model work: a unified fold may have committed meanwhile.
  const previous = loadActiveIndex(root)?.active ?? null;
  if (previous && Number(previous.checkpoint) >= checkpoint) {
    return { chunks: 0, delta: null, active: previous, turnEndSeq: completed.at(-1).turnEndSeq ?? checkpoint };
  }
  const delta = appendIncrement(root, {
    active: previous, deltaId: `delta-${checkpoint}`, summaries: seed.summaries, vectors: seed.vectors,
    fromCheckpoint: watermark, toCheckpoint: checkpoint, identity: previous?.identity ?? identity,
  });
  return { chunks: chunks.length, delta: delta.delta, active: delta.active, turnEndSeq: completed.at(-1).turnEndSeq ?? checkpoint };
}

export function startupReconcile({ root, sessionId, events, provider, embedder, identity }) {
  const active = loadActiveIndex(root);
  if (!active) return Promise.resolve({ skipped: 'no-active' });
  const queue = readQueue(root).filter((row) => row.sessionId === sessionId && row.status === 'pending');
  if (queue.length === 0) return Promise.resolve({ skipped: 'empty-queue' });
  return processIncrement({ root, sessionId, events, watermark: active.active.checkpoint, provider, embedder, identity });
}

export function workerDefaults({ provider, embedder, identity = null } = {}) {
  return { provider, embedder, identity: identity ?? buildIdentity({ promptTextSha256: 'prompt', extractionRuleSha256: 'extract' }) };
}
