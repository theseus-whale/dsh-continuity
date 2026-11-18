import fs from 'node:fs';
import path from 'node:path';

export function enqueueTurnEnd(root, { sessionId, turn, seq, at = new Date().toISOString() }) {
  fs.mkdirSync(root, { recursive: true });
  const line = `${JSON.stringify({ sessionId, turn, seq, at })}\n`;
  fs.appendFileSync(path.join(root, 'increment-queue.jsonl'), line, 'utf8');
  return { enqueued: true, sessionId, turn, seq };
}

export function readIncrementQueue(root) {
  const file = path.join(root, 'increment-queue.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

/** Enqueue-only host hook: never calls provider inside the turn. */
export function installTurnStoppingEnqueue({ ctx, root, sessionIdOf = (agent) => agent?.session?.id }) {
  return ctx.on('agent/turn-stopping', async ({ turn, signal } = {}) => {
    const sessionId = sessionIdOf(ctx.agent);
    if (!sessionId) return;
    return enqueueTurnEnd(root, { sessionId, turn, seq: signal?.aborted ? null : turn });
  });
}

/** Build the increment chunk set from raw events after a completed watermark. */
export function incrementChunks({ sessionId, events, watermarkSeq, buildRawChunks }) {
  const tail = events.filter((event) => Number(event.seq) > Number(watermarkSeq));
  return buildRawChunks(sessionId, tail, { checkpointSeq: Infinity });
}
