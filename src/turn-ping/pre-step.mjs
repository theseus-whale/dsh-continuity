import { join } from 'node:path';
import { memoryCueMessage, retiredMemoryCueMessage, isMemoryCueMessage } from '../memory-cue.mjs';
import { turnPingQueryInfo } from './query.mjs';
import { appendDiagnostic } from './diagnostics.mjs';
import { sha256 } from './config.mjs';
import { extractVisibleMemoryIds, hasMemoryIntent, readQuietConfig } from './quiet.mjs';
import { continuityHome, readRules, readHabits } from '../threads-store.mjs';
import { createBgeEmbedder } from './host-adapters.mjs';
import { findRulesCarrierSeqs, planRulesLifecycle, rulesCarrierSignature } from '../rules-lifecycle.mjs';
import {
  appendRuleCueLog, isRuleCueMessage, markRuleCueHistory, parseRuleBlocks, readRuleCueConfig, recentRuleCueIds,
  retiredRuleCueMessage, ruleCueMessage, scoreRuleBlocks, selectNovelRuleHits, stripRuleCueTransportEnvelope,
} from '../rule-cue.mjs';

export function installTurnPingPreStep({ ctx, config = {}, beforeAnswer, contextMessage, log = console, diagnosticPath = null, ruleCueTurn = null }) {
  if (!ctx || typeof ctx.on !== 'function') throw new Error('turn-ping pre-step: ctx.on required');
  const debug = (entry) => {
    if (config.diagnostics?.enabled === true) appendDiagnostic(diagnosticPath ?? config.diagnostics.path ?? null, entry);
  };
  const ruleCue = readRuleCueConfig(config);
  const ruleCueCache = new Map();
  const ruleCueEmbedder = ruleCue.mode === 'off' ? null : createBgeEmbedder({
    model: ruleCue.embeddingModel ?? join(continuityHome(), 'models', 'Xenova', 'bge-small-zh-v1.5'),
  });
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
  const ruleCueSeqs = (session) => {
    const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : [];
    const found = [];
    for (const seq of nodes) {
      const event = typeof session?.eventAt === 'function' ? session.eventAt(seq) : null;
      const message = event?.data?.message ?? event?.data;
      if (message?.role === 'user' && isRuleCueMessage(message)) found.push(seq);
    }
    return found;
  };
  const clearRulePings = (session, logEntry) => {
    const old = ruleCueSeqs(session);
    for (const seq of old) {
      try {
        session.append('user/message', retiredRuleCueMessage(), { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] });
      } catch (error) {
        debug({ ...logEntry, kind: 'rule-cue-ttl-error', error: String(error?.message ?? error), seq });
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
  const evaluateRuleCue = async ({ session, text, sourceKind, fullInjected, liveInjection }) => {
    const root = join(continuityHome(), 'sessions', String(session?.id ?? 'unknown'));
    const empty = { selected: [], fullInjected, liveInjection: false };
    if (ruleCue.mode === 'off') return empty;
    if (fullInjected) {
      appendRuleCueLog(root, { sessionId: session?.id ?? null, fullInjected: true, selected: [], reason: 'full-carrier-present', querySha256: sha256(text), sourceKind, injected: false, shadow: true });
      return empty;
    }
    if (!text || !ruleCueEmbedder) return empty;
    try {
      const [rules, habits] = await Promise.all([readRules(session.id), readHabits(session.id)]);
      const signature = rulesCarrierSignature(rules.text, habits.text);
      let cached = ruleCueCache.get(session.id);
      if (!cached || cached.signature !== signature) {
        const blocks = [...parseRuleBlocks(rules.text, 'R', rules.path), ...parseRuleBlocks(habits.text, 'H', habits.path)];
        for (const block of blocks) block.vector = await ruleCueEmbedder(block.vectorText, 'document');
        cached = { signature, blocks };
        ruleCueCache.set(session.id, cached);
      }
      const queryVector = await ruleCueEmbedder(text, 'query');
      const { top, threshold, candidates } = scoreRuleBlocks(cached.blocks, queryVector, ruleCue);
      const recent = recentRuleCueIds(root, Date.now(), ruleCue.historyWindowMs);
      const fresh = candidates.filter(hit => !recent.has(hit.id));
      const selected = selectNovelRuleHits(fresh, [], ruleCue.noveltyThreshold);
      if (selected.length) markRuleCueHistory(root, selected.map(hit => hit.id));
      const injected = liveInjection === true && selected.length > 0;
      appendRuleCueLog(root, {
        sessionId: session.id, fullInjected: false, top, threshold, queryText: text, querySha256: sha256(text), sourceKind,
        candidates: candidates.map(hit => ({ id: hit.id, section: hit.section, score: hit.score, text: hit.text })),
        selected: selected.map(hit => ({ id: hit.id, section: hit.section, score: hit.score, text: hit.text })),
        recentRuleIds: [...recent], injected, shadow: !injected,
      });
      return { selected, fullInjected: false, liveInjection: injected };
    } catch (error) {
      appendRuleCueLog(root, { sessionId: session?.id ?? null, fullInjected: false, selected: [], reason: 'error', error: String(error?.message ?? error), queryText: text, querySha256: sha256(text), sourceKind, injected: false, shadow: true });
      log.warn?.(`[dsh-continuity] Rule Cue skipped: ${error?.message ?? error}`);
      return empty;
    }
  };
  const runRuleCue = async ({ session, text, sourceKind, liveInjection }) => {
    if (ruleCue.mode === 'off' || !text) return { selected: [], fullInjected: false, liveInjection: false };
    const nodes = session?.surface?.nodes ?? [];
    const fullCarriers = findRulesCarrierSeqs(session);
    const fullCarrierSeq = fullCarriers.at(-1) ?? null;
    const fullCarrier = fullCarrierSeq === null ? null : { seq: fullCarrierSeq, event: typeof session.eventAt === 'function' ? session.eventAt(fullCarrierSeq) : null };
    const [rules, habits] = await Promise.all([readRules(session.id), readHabits(session.id)]);
    const fullPlan = planRulesLifecycle({
      hasContent: rules.text.length + habits.text.length > 0,
      signature: rulesCarrierSignature(rules.text, habits.text), carrier: fullCarrier, surfaceSeqs: new Set(nodes),
    });
    return evaluateRuleCue({ session, text, sourceKind, fullInjected: fullPlan.action !== 'none', liveInjection });
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
        const retiredRuleCues = clearRulePings(session, { kind: 'rule-cue-ttl' });
        if (retiredRuleCues.length > 0) debug({ kind: 'rule-cue-ttl', sessionId: session?.id ?? null, retiredSeqs: retiredRuleCues });
        debug({ kind: 'skipped', reason: 'live-injection-not-allowed' });
        return decision;
      }
      const info = turnPingQueryInfo(decision?.messages ?? []);
      const text = info.text;
      // A tool follow-up has no new user query: keep the current rule cue until the next real user turn.
      if (text) {
        const retiredRuleCues = clearRulePings(session, { kind: 'rule-cue-ttl' });
        if (retiredRuleCues.length > 0) debug({ kind: 'rule-cue-ttl', sessionId: session?.id ?? null, retiredSeqs: retiredRuleCues });
      }
      const cueText = stripRuleCueTransportEnvelope(text);
      const liveInjection = ruleCue.mode === 'live'
        && ruleCue.liveSessionIds.includes(String(session?.id))
        && config.boundaries?.allowLiveInjection === true;
      const cue = text ? await (ruleCueTurn ?? runRuleCue)({ session, text: cueText, sourceKind: info.sourceKind, liveInjection }) : null;
      if (liveInjection && cue?.liveInjection === true && Array.isArray(cue.selected) && cue.selected.length > 0) {
        decision.messages = [...(decision.messages ?? []), ruleCueMessage(cue.selected)];
      }
      const quiet = readQuietConfig(config);
      const visibleMemoryIds = new Set(pingSeqs(session).flatMap(item => [...extractVisibleMemoryIds(item.text)]));
      debug({ kind: 'auto-recall-mode', sessionId: session?.id ?? null, mode: quiet.mode, visibleMemoryIds: visibleMemoryIds.size });
      if (quiet.mode === 'off') {
        clearPings(session, { kind: 'quiet-off' });
        return decision;
      }
      if (quiet.mode === 'quiet' && !hasMemoryIntent(text)) {
        clearPings(session, { kind: 'no-memory-intent' });
        return decision;
      }
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
      const result = await beforeAnswer({ sessionId: String(session.id), query: text, cutoff, events, quiet: quiet.mode === 'quiet', visibleMemoryIds });
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
