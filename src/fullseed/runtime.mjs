import fs from 'node:fs';
import path from 'node:path';
import { loadActiveIndex } from './cache.mjs';
import { processIncrement, readQueue } from './worker.mjs';
import { buildIdentity } from './seed.mjs';
import { PROMPT_TEXT_SHA256, EXTRACTION_RULE_SHA256 } from './summary.mjs';

function sessionRoots(home) {
  const root = path.join(home, 'sessions');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ sessionId: entry.name, fullseed: path.join(root, entry.name, 'turn-ping', 'fullseed') }))
    .filter((entry) => fs.existsSync(path.join(entry.fullseed, 'active.json')));
}

export function createFullseedWorker({ home, sessionQuery, provider, embedder, identity, intervalMs = 15_000, log = () => {}, allowedSessionIds = null }) {
  if (typeof sessionQuery?.readSession !== 'function') throw new Error('fullseed worker: sessionQuery.readSession required');
  if (typeof provider !== 'function' || typeof embedder !== 'function') throw new Error('fullseed worker: provider/embedder required');
  let running = false;
  let stopped = false;
  let firstTick = true;
  async function tick() {
    if (running || stopped) return 0;
    running = true;
    let processed = 0;
    try {
      for (const { sessionId, fullseed } of sessionRoots(home)) {
        if (allowedSessionIds && !allowedSessionIds.has(String(sessionId))) continue;
        const active = loadActiveIndex(fullseed);
        if (!active) continue;
        const allQueue = readQueue(fullseed);
        const doneIds = new Set(allQueue.filter((row) => row.status === 'done' && row.queueId).map((row) => row.queueId));
        const pending = allQueue.filter((row) => row.sessionId === sessionId && row.status === 'pending' && !doneIds.has(row.queueId));
        if (!firstTick && pending.length === 0) continue;
        const session = await sessionQuery.readSession(String(sessionId));
        const result = await processIncrement({ root: fullseed, sessionId, events: session?.events ?? [], watermark: active.active.checkpoint, provider, embedder, identity: active.active.identity ?? identity });
        // A successful no-op also settles the queue: another fold may already
        // have covered this checkpoint. Errors still leave pending work intact.
        for (const row of pending) {
          fs.appendFileSync(path.join(fullseed, 'increment-queue.jsonl'), `${JSON.stringify({ ...row, status: 'done', at: new Date().toISOString(), chunks: result.chunks, turnEndSeq: result.turnEndSeq ?? null, checkpoint: result.active?.checkpoint ?? null })}\n`, 'utf8');
        }
        if (result.chunks > 0) {
          processed += result.chunks;
          log({ sessionId, chunks: result.chunks, checkpoint: result.active?.checkpoint });
        }
      }
    } finally { running = false; firstTick = false; }
    return processed;
  }
  const timer = setInterval(() => { void tick().catch((error) => log({ error: String(error?.message ?? error) })); }, intervalMs);
  timer.unref?.();
  const ready = tick().catch((error) => { log({ error: String(error?.message ?? error) }); return 0; });
  return { tick, ready, stop: () => { stopped = true; clearInterval(timer); } };
}

export function workerIdentityFromConfig(config = {}) {
  return config.fullseedIdentity ?? buildIdentity({ promptTextSha256: PROMPT_TEXT_SHA256, extractionRuleSha256: EXTRACTION_RULE_SHA256 });
}
