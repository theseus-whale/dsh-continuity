/**
 * B+C pre-step note injection.
 *
 * Pure: no LLM, no network, no writes. The caller owns C and the record store.
 */
import { appendFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { contextMessage } from '../threads.mjs';
import { lastUserText } from './extraction-pre-step.mjs';
import { createCMap, DEFAULT_C_SEED, formatIntervals, groupHits, markAsked, renderNote, retrieve } from './bc-recall.mjs';
import { detectRecallCue } from './recall-cue.mjs';
import { loadIndexJsonl } from './bc-index.mjs';
import { defaultBCStorePath, loadBCStore } from './bc-store.mjs';
import { loadSpecialKeywords, matchSpecialKeywords } from './special-keywords.mjs';
import { loadCMapEntries } from './cmap-file.mjs';
import { loadConcepts } from './concepts-file.mjs';
import { appendCostLog, createIndexUpdater, defaultCostLogPath } from './bc-index-updater.mjs';
import { createBLabeler } from './bc-label.mjs';
import { consumePendingHint, maybeRunAudit } from './bc-audit.mjs';
import { ensureSessionScaffolds, maybeOnboard, bootstrapPaths } from './onboarding.mjs';
import { isPersonaEnabled, resolvePersona, resolveVocabFile, sessionFile } from './persona.mjs';
import { embedTexts } from '../facets/embedding.mjs';
import { eventText } from '../session-log.mjs';

const INJECTED = /^\[(?:抽取|工作线|标签|规则|习惯|技能|归位|候选|存\?|闸|回正|学习|追忆|记忆|continuity:[a-z-]+)\]/;
const MACHINE_PREFIX = /^(?:Current runtime context|Current working directory|Current DSH file policy|Approval prompts|Time sampled)/;

function liveNote(events, query, { beforeTurn = Infinity } = {}) {
  const hits = (events ?? []).filter((event) => {
    const source = event?.data?.source ?? event?.source;
    if (source && typeof source.kind === 'string' && source.kind !== 'user') return false;
    if (source && source.peer === true) return false;
    const text = eventText(event).trim();
    if (!text || INJECTED.test(text) || MACHINE_PREFIX.test(text) || !text.includes(query)) return false;
    const turn = Number(event?.data?.turn ?? event?.turn);
    return !Number.isFinite(turn) || turn < beforeTurn;
  }).sort((a, b) => Number(b.seq) - Number(a.seq)).map((event) => {
    const turn = Number(event?.data?.turn ?? event?.turn);
    const seq = Number(event?.seq);
    return { turn: Number.isFinite(turn) ? turn : null, seqStart: seq, seqEnd: seq, status: 'live', generic: [] };
  });
  if (hits.length === 0) return null;
  const groups = groupHits(hits);
  const line = (group) => group.fromTurn === null
    ? `seq ${group.fromSeq}-${group.toSeq}`
    : group.fromTurn === group.toTurn
      ? `turn ${group.fromTurn} / seq ${group.fromSeq}-${group.toSeq}`
      : `turn ${group.fromTurn}-${group.toTurn} / seq ${group.fromSeq}-${group.toSeq}`;
  const note = groups.length === 1
    ? `[追忆] 最近 ${query} -> ${line(groups[0])}`
    : `[追忆] 最近 ${query} -> ${groups.length} 段\n${formatIntervals(groups)}`;
  return {
    result: { kind: 'recall', via: 'live', term: query, hits },
    note: `${note}\n如需上下文，可按需前后读更多 turn。`,
  };
}

function autoSpecialKeywords(words) {
  // One-character Chinese names/emoji are too common as vocatives ("创看看").
  // They remain available through manual recall(), but do not auto-trigger.
  return words.filter((word) => [...String(word)].length >= 2);
}

function renderAnchorNote(result, anchor) {
  if (!result || result.kind !== 'recall' || !Array.isArray(result.hits) || result.hits.length === 0) return null;
  const groups = groupHits(result.hits);
  if (groups.length === 0) return null;
  const weak = groups.some((group) => group.weak) ? ' · weak' : '';
  const header = groups.length === 1
    ? `[追忆] ${anchor.term}${weak} · ${groups[0].fromTurn === null ? `seq ${groups[0].fromSeq}-${groups[0].toSeq}` : `turn ${groups[0].fromTurn}${groups[0].fromTurn === groups[0].toTurn ? '' : '-' + groups[0].toTurn} / seq ${groups[0].fromSeq}-${groups[0].toSeq}`}`
    : `[追忆] ${anchor.term}${weak} · 显示 ${Math.min(3, groups.length)} / 共 ${groups.length} 个区间`;
  const lines = [header];
  if (groups.length > 1) lines.push(formatIntervals(groups, { max: 3, showRemainder: false }));
  lines.push(`更多用 recall("${anchor.term}")`);
  return lines.join('\n');
}

function logIndexError(error) {
  try {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
    appendFileSync(join(home, '.dsh', 'continuity', 'gate-errors.jsonl'), JSON.stringify({
      at: new Date().toISOString(), code: 'bc-index-update-failed',
      name: String(error?.name ?? 'Error'),
      message: String(error?.message ?? error),
    }) + '\n', 'utf8');
  } catch { /* error logging must not block the turn */ }
}

function logIndexUnavailable(reason, store = null) {
  try {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
    appendFileSync(join(home, '.dsh', 'continuity', 'gate-errors.jsonl'), JSON.stringify({
      at: new Date().toISOString(), code: 'bc-index-unavailable', reason,
      store, pid: process.pid,
    }) + '\n', 'utf8');
  } catch { /* error logging must not block the turn */ }
}

export function createBCPreStep({ records = [], cmap, prefix = '', sessionQuery = null, cmapFile = undefined, keywordsFile = null, updateIndex = null, bLabeler = null, auditIndexFile = null, auditConceptsFile = null } = {}) {
  let repairTimer = null;
  let activeBLabeler = bLabeler;
  const scheduleRepair = (agent, lastTurn) => {
    if (repairTimer !== null || updateIndex === null) return;
    repairTimer = setTimeout(async () => {
      repairTimer = null;
      const update = await updateIndex({ agent, lastTurn });
      if (update?.records?.length) records.push(...update.records);
      if (update?.remaining > 0) scheduleRepair(agent, lastTurn);
    }, 250);
    repairTimer.unref?.();
  };
  return async function bcPreStep(payload, next) {
    const decision = await next();
    if (!decision || !Array.isArray(decision.messages)) return decision;
    if (Number.isInteger(payload?.step) && payload.step !== 1) return decision;
    if (updateIndex !== null) {
      const update = await updateIndex({ agent: payload?.agent, lastTurn: payload?.agent?.lastTurn });
      if (update?.records?.length) records.push(...update.records);
      if (update?.remaining > 0) scheduleRepair(payload?.agent, payload?.agent?.lastTurn);
      if (auditIndexFile !== null && auditConceptsFile !== null && loadConcepts(auditConceptsFile).length > 0) {
        const lastTurn = update?.records?.at(-1)?.turn ?? payload?.agent?.lastTurn;
        try { maybeRunAudit({ indexFile: auditIndexFile, conceptsFile: auditConceptsFile, lastTurn }); } catch { /* audit must not block */ }
      }
    }
    let auditNote = null;
    if (auditIndexFile !== null) {
      try { auditNote = consumePendingHint(auditIndexFile); } catch { /* ignore */ }
    }
    try {
      maybeOnboard({ session: payload?.agent?.session, messages: decision.messages });
    } catch { /* onboarding must not block */ }
    let auditInjected = false;
    if (auditNote) {
      const auditText = prefix ? `${prefix}\n${auditNote}` : auditNote;
      const session = payload?.agent?.session;
      if (session && typeof session.append === 'function') {
        try {
          session.append('user/message', contextMessage(auditText), { surfaceOp: 'append' });
          auditInjected = true;
        } catch { /* fall back to decision messages */ }
      }
    }
    const withAudit = (value) => auditInjected
      ? value
      : (auditNote ? { ...value, messages: [...value.messages, contextMessage(prefix ? `${prefix}\n${auditNote}` : auditNote)] } : value);
    const before = withAudit(decision);
    const text = lastUserText(before.messages);
    if (!text) return before;
    const cue = detectRecallCue(text);
    if (!cue.hit) return before;
    if (cmap?.terms && cmapFile !== null) {
      for (const entry of loadCMapEntries(cmapFile)) cmap.terms.set(entry.term, entry.generic);
    }

    const pronoun = /^(?:那个|那件事|这件事|这个|它)$/;
    const specialWords = keywordsFile && !existsSync(keywordsFile) ? [] : loadSpecialKeywords(keywordsFile ?? undefined);
    const kAnchors = autoSpecialKeywords(matchSpecialKeywords(text, specialWords))
      .filter((word) => !pronoun.test(word))
      .map((word) => ({ term: word, type: 'K', score: 1 }));
    let anchor = kAnchors[0] ?? null;
    if (anchor === null && cmap?.terms) {
      const cTerms = [...cmap.terms.keys()]
        .filter((term) => term.length > 0 && text.includes(term) && !pronoun.test(term))
        .sort((a, b) => b.length - a.length);
      if (cTerms.length > 0) anchor = { term: cTerms[0], type: 'C', score: 0.9 };
    }
    if (anchor === null) {
      if (activeBLabeler === null) activeBLabeler = createBLabeler({ embed: embedTexts });
      const label = await activeBLabeler.label(text, { topK: 3, minScore: 0.5 });
      const top = label.candidates?.[0] ?? null;
      if (top && top.score >= 0.5 && text.includes(top.concept)) anchor = { term: top.concept, type: 'B', score: top.score };
    }
    if (anchor === null) return withAudit({ ...decision, cue });

    const result = retrieve({
      records,
      cmap,
      query: anchor.term,
      specialKeywords: anchor.type === 'K' ? [anchor.term] : [],
    });
    const note = renderAnchorNote(result, anchor);
    if (!note) return withAudit({ ...decision, bc: result, cue, anchor });
    if (result.kind === 'ask') markAsked(cmap, result.term);
    return {
      ...before,
      messages: [...before.messages, contextMessage(prefix ? `${prefix}\n${note}` : note)],
      bc: result,
      cue,
      anchor,
    };
  };
}

export function installBCPreStep(ctx, { enabled = false, storePath = null, prefix = '', sessionQuery = null, sessionScoped = null } = {}) {
  if (enabled !== true) return { registered: false, reason: 'disabled' };
  if (!ctx || typeof ctx.on !== 'function') return { registered: false, reason: 'no-ctx' };
  const resolvedStore = storePath ?? defaultBCStorePath();
  const isJsonl = /\.jsonl$/i.test(resolvedStore);
  const scoped = sessionScoped === null ? (storePath === null && isJsonl) : sessionScoped === true;
  const sessionsDir = join(dirname(resolvedStore), 'sessions');
  const resolveSessionQuery = () => {
    if (sessionQuery && typeof sessionQuery.readSession === 'function') return sessionQuery;
    if (typeof ctx.get === 'function') return ctx.get('sessionQuery');
    return ctx.sessionQuery;
  };
  const lazySessionQuery = {
    async readSession(sessionId) {
      const query = resolveSessionQuery();
      if (!query || typeof query.readSession !== 'function') {
        throw new Error('sessionQuery service unavailable');
      }
      return query.readSession(sessionId);
    },
  };
  const conceptsPath = resolveVocabFile('continuity', 'concepts.md');
  const cmapPath = resolveVocabFile('continuity', 'cmap.md');
  const keywordsPath = resolveVocabFile('continuity', 'keywords.md');
  const conceptRows = loadConcepts(conceptsPath);
  const noBootstrap = !existsSync(bootstrapPaths().stateFile);
  const initialLabels = conceptRows.length > 0
    ? Object.fromEntries(conceptRows.map((row) => [row.label, row.description]))
    : (existsSync(conceptsPath) || noBootstrap ? {} : null);
  const initialKinds = Object.fromEntries(conceptRows.map((row) => [row.label, row.kind]));
  const initialLabeler = initialLabels === null
    ? null
    : createBLabeler({ embed: embedTexts, labels: initialLabels, concepts: Object.keys(initialLabels), kinds: initialKinds });
  const sessionVocabStamp = (sessionId) => {
    const stampOf = (file) => {
      try {
        const stat = statSync(file);
        return `${stat.mtimeMs}:${stat.size}`;
      } catch {
        return 'missing';
      }
    };
    return `${stampOf(sessionFile(sessionId, 'concepts.md'))}|${stampOf(sessionFile(sessionId, 'cmap.md'))}`;
  };
  const makeStep = (indexFile, sessionId) => {
    const records = existsSync(indexFile) ? loadIndexJsonl(indexFile) : [];
    const conceptsPath = sessionFile(sessionId, 'concepts.md');
    const keywordsPath = sessionFile(sessionId, 'keywords.md');
    const cmapPath = sessionFile(sessionId, 'cmap.md');
    const stampOf = (file) => {
      try {
        const stat = statSync(file);
        return `${stat.mtimeMs}:${stat.size}`;
      } catch {
        return 'missing';
      }
    };
    const vocabStamp = `${stampOf(conceptsPath)}|${stampOf(cmapPath)}`;
    const conceptRows = loadConcepts(conceptsPath);
    const labels = conceptRows.length > 0
      ? Object.fromEntries(conceptRows.map((row) => [row.label, row.description]))
      : {};
    const kinds = Object.fromEntries(conceptRows.map((row) => [row.label, row.kind]));
    const labeler = createBLabeler({ embed: embedTexts, labels, concepts: Object.keys(labels), kinds });
    const cmap = createCMap([...DEFAULT_C_SEED, ...loadCMapEntries(cmapPath)]);
    const updateIndex = createIndexUpdater({
      file: indexFile,
      stateFile: join(dirname(indexFile), 'bc-index-state.json'),
      sessionQuery: lazySessionQuery,
      labels,
      kinds,
      keywordsFile: keywordsPath,
      cmapFile: cmapPath,
      onError: logIndexError,
      onCost: (cost) => appendCostLog(defaultCostLogPath(), cost),
    });
    return {
      records,
      cmap,
      vocabStamp,
      step: createBCPreStep({ records, cmap, prefix, sessionQuery: lazySessionQuery, updateIndex, bLabeler: labeler, cmapFile: cmapPath, keywordsFile: keywordsPath, auditIndexFile: indexFile, auditConceptsFile: conceptsPath }),
      updateIndex,
    };
  };

  if (scoped) {
    const bySession = new Map();
    const getSession = (sessionId) => {
      if (!sessionId) return null;
      const personaId = resolvePersona(sessionId);
      if (!isPersonaEnabled(personaId)) return null;
      ensureSessionScaffolds({ sessionId });
      const vocabStamp = sessionVocabStamp(sessionId);
      let entry = bySession.get(sessionId);
      if (entry !== undefined && entry.vocabStamp !== vocabStamp) {
        bySession.delete(sessionId);
        entry = undefined;
      }
      if (entry === undefined) {
        const indexFile = join(sessionsDir, String(sessionId), 'bc-index.jsonl');
        entry = makeStep(indexFile, sessionId);
        bySession.set(sessionId, entry);
      }
      return entry;
    };
    ctx.on('agent/pre-step', async (payload, next) => {
      const entry = getSession(payload?.agent?.session?.id);
      if (entry === null) return next();
      return entry.step(payload, next);
    });
    return {
      registered: true,
      records: 0,
      cmapTerms: 0,
      indexUpdater: true,
      sessionQuery: 'lazy',
      store: sessionsDir,
      sessionScoped: true,
    };
  }

  const store = isJsonl
    ? { records: loadIndexJsonl(resolvedStore), cmap: createCMap([...DEFAULT_C_SEED, ...loadCMapEntries(cmapPath)]) }
    : loadBCStore(resolvedStore);
  const updateIndex = isJsonl ? createIndexUpdater({
    file: resolvedStore,
    stateFile: join(dirname(resolvedStore), 'bc-index-state.json'),
    sessionQuery: lazySessionQuery,
    labels: initialLabels,
    kinds: initialKinds,
    keywordsFile: keywordsPath,
    cmapFile: cmapPath,
    onError: logIndexError,
    onCost: (cost) => appendCostLog(defaultCostLogPath(), cost),
  }) : null;
  const isTempProbe = /[\\/]Temp[\\/]bc-install-[^\\/]+[\\/]/i.test(resolvedStore);
  if (updateIndex === null && !isTempProbe) logIndexUnavailable('store is not bc-index.jsonl', resolvedStore);
  ctx.on('agent/pre-step', createBCPreStep({ records: store.records, cmap: store.cmap, prefix, sessionQuery: lazySessionQuery, updateIndex, bLabeler: initialLabeler, cmapFile: cmapPath, keywordsFile: keywordsPath, auditIndexFile: isJsonl ? resolvedStore : null, auditConceptsFile: conceptsPath }));
  return {
    registered: true,
    records: store.records.length,
    cmapTerms: store.cmap.terms.size,
    indexUpdater: Boolean(updateIndex),
    sessionQuery: 'lazy',
    store: resolvedStore,
    sessionScoped: false,
  };
}
