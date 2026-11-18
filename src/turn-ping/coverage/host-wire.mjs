import { openSessionCoverage, resumeStartupSessions } from './lifecycle.mjs';
import { onFoldCoverage } from './index.mjs';
import { createTurnPingStorage } from '../storage.mjs';
import { createCoverageJournal } from './journal.mjs';
import { buildTurnsFromEvents } from '../host.mjs';
import { readConfig } from '../config.mjs';

export const COVERAGE_HOST_CAPABILITIES = Object.freeze({
  activeSessionEnumeration: false,
  startupResume: 'unavailable: no public host event enumerates all live sessions',
  sessionOpen: 'agent/created + session/created',
  lazyFallback: 'agent/pre-step one bounded attempt per session when created did not fire',
  fold: 'engine.recordFolded + session/event compaction/summary journal',
  preModelQuery: 'agent/pre-step payload/decision messages',
  provider: 'ctx.llm.stream requires explicit provider/model config',
  embedder: 'no host embedding service; requires explicit BGE adapter',
});

function sessionSnapshot(session) {
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : [];
  const seqs = events.map((event) => Number(event?.seq)).filter(Number.isInteger);
  const checkpoint = seqs.length > 0 ? Math.max(...seqs) : null;
  const surface = session?.surface?.nodes ?? [];
  const activeTailStartSeq = surface.length > 0 ? Number(surface[0]) : null;
  const foldedSeqs = [];
  for (const event of events) {
    if (event?.type !== 'compaction/summary') continue;
    for (const seq of event?.data?.shadowedSeqs ?? []) if (Number.isInteger(Number(seq))) foldedSeqs.push(Number(seq));
  }
  return { events, checkpoint, activeTailStartSeq, foldedSeqs, turns: buildTurnsFromEvents(session?.id, events) };
}

/**
 * Wires only real host events; no fixture and no timers. Default false means no
 * listeners, no adapters, no work. Per-session open runs a bounded resume with
 * the current snapshot; startup enumeration is not invented.
 */
export function wireCoverageHost({ ctx, config = {}, home, provider = null, embedder = null }) {
  if (config?.enabled !== true) return { wired: false, reason: 'disabled', capabilities: COVERAGE_HOST_CAPABILITIES };
  if (!ctx || typeof ctx.on !== 'function') return { wired: false, reason: 'no-host-event-api', capabilities: COVERAGE_HOST_CAPABILITIES };
  const runConfig = readConfig({ ...config, enabled: true, boundaries: { ...(config.boundaries ?? {}), allowDefaultEnable: true } });
  runConfig.autoActivate = config.autoActivate === true;
  const seen = new Set();
  const inFlight = new Map();
  const attempts = new Map();
  const onOpen = async (session) => {
    if (!session?.id) return { skipped: 'no-session' };
    const sessionId = String(session.id);
    if (seen.has(sessionId)) return { skipped: 'seen' };
    if (inFlight.has(sessionId)) return inFlight.get(sessionId);
    const snapshot = sessionSnapshot(session);
    if (!Number.isInteger(snapshot.checkpoint) || !Number.isInteger(snapshot.activeTailStartSeq)) {
      attempts.set(sessionId, (attempts.get(sessionId) ?? 0) + 1);
      return { skipped: 'invalid-snapshot', attempts: attempts.get(sessionId) };
    }
    const work = (async () => {
      try {
        const opened = await openSessionCoverage({
          home,
          sessionId,
          events: snapshot.events,
          turns: snapshot.turns,
          checkpoint: snapshot.checkpoint,
          activeTailStartSeq: snapshot.activeTailStartSeq,
          foldedSeqs: snapshot.foldedSeqs,
          indexVersion: config.indexVersion ?? null,
        });
        seen.add(sessionId);
        let resumed = null;
        if (typeof provider === 'function' && typeof embedder === 'function') {
          const rows = await resumeStartupSessions({
            home,
            sessions: [sessionId],
            eventsBySession: { [sessionId]: snapshot.events },
            config: runConfig,
            provider,
            embedder,
          });
          resumed = rows[0] ?? null;
        }
        return { opened, resumed };
      } catch (error) {
        attempts.set(sessionId, (attempts.get(sessionId) ?? 0) + 1);
        try {
          const journal = createCoverageJournal({ home, sessionId });
          await journal.ledger({ at: new Date().toISOString(), kind: 'host-open-failed', error: String(error?.message ?? error), attempt: attempts.get(sessionId) });
        } catch { /* audit failure must not block the step */ }
        return { skipped: 'open-failed', error: String(error?.message ?? error), attempts: attempts.get(sessionId) };
      } finally {
        inFlight.delete(sessionId);
      }
    })();
    inFlight.set(sessionId, work);
    return work;
  };
  ctx.on('agent/created', (payload = {}) => onOpen(payload?.agent?.session));
  ctx.on('session/created', (session) => onOpen(session));
  ctx.on('agent/pre-step', (payload, next) => {
    const session = payload?.agent?.session;
    if (session?.id && !seen.has(String(session.id)) && (attempts.get(String(session.id)) ?? 0) < 3) {
      // Start a bounded per-session job and let this turn proceed immediately.
      void onOpen(session).catch(() => { /* onOpen records its own failure ledger */ });
    }
    return next();
  });
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'compaction/summary') return undefined;
    const shadowedSeqs = Array.isArray(event?.data?.shadowedSeqs) ? event.data.shadowedSeqs : [];
    if (shadowedSeqs.length === 0) return undefined;
    return onFoldCoverage({ home, sessionId: String(session?.id), fold: { foldId: event?.data?.compactionId ?? event?.seq, shadowedSeqs, from: Math.min(...shadowedSeqs), to: Math.max(...shadowedSeqs) } });
  });
  return {
    wired: true,
    capabilities: COVERAGE_HOST_CAPABILITIES,
    onOpen,
    jobs: () => [...inFlight.values()],
    resume: (sessions, eventsBySession) => resumeStartupSessions({ home, sessions, eventsBySession, config: runConfig, provider, embedder }),
    storage: (sessionId) => createTurnPingStorage({ home, sessionId }),
  };
}
