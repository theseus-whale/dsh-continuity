import { memoryCueMessage, retiredMemoryCueMessage, isMemoryCueMessage } from '../memory-cue.mjs';
import { turnPingQueryInfo } from './query.mjs';
import { appendDiagnostic } from './diagnostics.mjs';
import { sha256 } from './config.mjs';

export function installTurnPingPreStep({ ctx, config = {}, beforeAnswer, contextMessage, log = console, diagnosticPath = null }) {
  if (!ctx || typeof ctx.on !== 'function') throw new Error('turn-ping pre-step: ctx.on required');
  const debug = (entry) => {
    if (config.diagnostics?.enabled === true) appendDiagnostic(diagnosticPath ?? config.diagnostics.path ?? null, entry);
  };
  const pingSeqs = (session) => {
    const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : [];
    const found = [];
    for (const seq of nodes) {
      const event = typeof session?.eventAt === 'function' ? session.eventAt(seq) : null;
      const message = event?.data?.message ?? event?.data;
      if (message?.role === 'user' && isMemoryCueMessage(message)) found.push({ seq, text: message?.content?.[0]?.text ?? '' });
    }
    return found;
  };
  const clearPings = (session, logEntry) => {
    const old = pingSeqs(session);
    for (const item of old) {
      try {
        session.append('user/message', retiredMemoryCueMessage(), { surfaceOp: { op: 'replace', startSeq: item.seq, endSeq: item.seq }, sourceEventSeqs: [item.seq] });
      } catch (error) {
        debug({ ...logEntry, kind: 'ttl-error', error: String(error?.message ?? error), seq: item.seq });
      }
    }
    return old;
  };
  const legacyCueSeqs = (session) => {
    const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : [];
    const found = [];
    for (const seq of nodes) {
      const event = typeof session?.eventAt === 'function' ? session.eventAt(seq) : null;
      const message = event?.data?.message ?? event?.data;
      if (message?.role === 'user' && message?.source?.kind === 'turn-ping-memory') found.push(seq);
    }
    return found;
  };
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    const session = payload?.agent?.session;
    const originalCount = Array.isArray(decision?.messages) ? decision.messages.length : 0;
    debug({
      kind: 'pre-step-entry',
      sessionId: session?.id ?? null,
      mode: config.mode ?? null,
      allowLiveInjection: config.boundaries?.allowLiveInjection === true,
      messageCount: originalCount,
      step: Number.isInteger(payload?.step) ? payload.step : null,
      providerRequestMessages: 'not-covered',
    });
    const legacyCues = legacyCueSeqs(session);
    if (legacyCues.length > 0) {
      debug({ kind: 'legacy-cue-detected', sessionId: session?.id ?? null, count: legacyCues.length, seqs: legacyCues, action: 'detected-not-retired' });
    }
    try {
      if (config.mode === 'opt-in' && config.boundaries?.allowLiveInjection !== true) {
        debug({ kind: 'skipped', reason: 'live-injection-not-allowed' });
        return decision;
      }
      const info = turnPingQueryInfo(decision?.messages ?? []);
      const text = info.text;
      const allowed = Array.isArray(config.sessionIds) && config.sessionIds.length > 0 ? new Set(config.sessionIds.map(String)) : null;
      if (allowed && !allowed.has(String(session?.id))) {
        debug({ kind: 'skipped', reason: 'session-not-allowed', sessionId: session?.id ?? null });
        return decision;
      }
      const nodes = session?.surface?.nodes ?? [];
      const cutoff = Number(nodes.at(-1));
      debug({
        kind: 'query',
        sessionId: session?.id ?? null,
        textLen: text.length,
        textSha256: text ? sha256(text) : null,
        sourceKind: info.sourceKind,
        sourcePeer: info.sourcePeer,
        normalizedKind: info.normalized?.source?.kind ?? null,
        normalizedPeer: info.normalized?.source?.peer ?? null,
        cutoff,
        nodesLast: nodes.length ? Number(nodes.at(-1)) : null,
      });
      if (!text || !Number.isInteger(cutoff)) {
        debug({ kind: 'skipped', reason: 'no-query-or-cutoff' });
        return decision;
      }
      const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : [];
      const result = await beforeAnswer({ sessionId: String(session.id), query: text, cutoff, events });
      debug({
        kind: 'before-answer',
        enabled: result?.enabled === true,
        H: result?.H ?? null,
        pingBytes: result?.ping?.bytes ?? null,
        pingSha256: result?.ping?.text ? sha256(result.ping.text) : null,
      });
      if (!result?.enabled || !result.ping?.text) {
        const cleared = clearPings(session, { kind: 'ttl-clear' });
        debug({ kind: 'return', originalCount, returnedCount: originalCount, appended: false, ttl: 'clear', clearedPings: cleared.map((item) => item.seq), previousPingSeq: cleared[0]?.seq ?? null });
        return decision;
      }
      const replaced = clearPings(session, { kind: 'ttl-replace' });
      const returned = { ...decision, messages: [...(decision.messages ?? []), memoryCueMessage(result.ping.text)] };
      const messages = returned.messages ?? [];
      const last = messages.at(-1);
      debug({
        kind: 'return',
        originalCount,
        returnedCount: messages.length,
        appended: true,
        ttl: 'replace',
        previousPingSeq: replaced[0]?.seq ?? null,
        replacedPings: replaced.map((item) => item.seq),
        lastSourceKind: last?.source?.kind ?? null,
        lastHasPing: /记忆共振|memory resonance/i.test(JSON.stringify(last?.content ?? '')),
        lastTextSha256: sha256(JSON.stringify(last?.content ?? '')),
        messages: messages.map((message) => ({
          role: message?.role ?? null,
          sourceKind: message?.source?.kind ?? null,
          textSha256: sha256(JSON.stringify(message?.content ?? '')),
        })),
      });
      return returned;
    } catch (error) {
      debug({ kind: 'error', error: String(error?.message ?? error) });
      log.warn?.(`[dsh-continuity] turn-ping pre-step skipped: ${error?.message ?? error}`);
      return decision;
    }
  });
  return { registered: true };
}
