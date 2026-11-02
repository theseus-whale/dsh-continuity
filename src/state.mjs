/**
 * Process-local state shared by the Host panel row and the compaction engine.
 *
 * The panel's HTTP route and the engine are two rows of one installed package,
 * so they resolve the same file URL and therefore the same module instance.
 * This is a diagnostic cache only: the session log remains the source of truth
 * for anything the model saw.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const continuityDir = () => join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'continuity');

/** Recompute the merged view from passes.jsonl plus the pre-pass folds sidecar.
 *  Each session gets its own sessions/<id>/dropped-ranges.json; sequence spaces
 *  from different sessions must never be merged together. */
export function rebuildDroppedRanges(sessionId = null) {
  try {
    const dir = continuityDir();
    let passes = [];
    try {
      passes = readFileSync(join(dir, 'passes.jsonl'), 'utf8')
        .split(/\r?\n/).filter(Boolean).map((line) => {
          try { return JSON.parse(line.replace(/^\uFEFF/, '')); } catch { return null; }
        }).filter(Boolean);
    } catch { /* no new pass log yet; folds may still cover history */ }
    let foldSessions = {};
    try {
      const parsed = JSON.parse(readFileSync(join(dir, 'folds.json'), 'utf8').replace(/^\uFEFF/, ''));
      foldSessions = parsed?.sessions ?? {};
    } catch { /* old install may have no folds sidecar */ }

    const passesBySession = new Map();
    for (const row of passes) {
      const id = row?.sessionId;
      if (typeof id !== 'string' || id === '') continue;
      if (!passesBySession.has(id)) passesBySession.set(id, []);
      passesBySession.get(id).push(row);
    }
    const ids = sessionId
      ? [String(sessionId)]
      : [...new Set([...passesBySession.keys(), ...Object.keys(foldSessions)])];
    for (const id of ids) {
      const sessionPasses = passesBySession.get(id) ?? [];
      const sessionFolds = Array.isArray(foldSessions?.[id]?.folds) ? foldSessions[id].folds : [];
      const entries = [
        ...sessionPasses.map((row) => ({ from: row.start, to: row.end, at: row.at, source: 'pass' })),
        ...sessionFolds.map((row) => ({ from: row.from, to: row.to, at: row.at, source: 'fold' })),
      ];
      const ranges = entries
        .map((row) => [Number(row.from), Number(row.to)])
        .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && start <= end)
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const merged = [];
      for (const [start, end] of ranges) {
        const last = merged.at(-1);
        if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
        else merged.push([start, end]);
      }
      const totalSeqs = merged.reduce((sum, [start, end]) => sum + (end - start + 1), 0);
      const times = entries.map((row) => row.at).filter((at) => typeof at === 'string' && at).sort();
      const sessionDir = join(dir, 'sessions', id);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'dropped-ranges.json'), `${JSON.stringify({
        updatedAt: new Date().toISOString(),
        sessionId: id,
        ranges: merged,
        totalSeqs,
        passes: sessionPasses.length,
        folds: sessionFolds.length,
        coverageFrom: times[0] ?? null,
        coverageNote: 'passes.jsonl is complete after 4.9.80; earlier ranges come from folds.json with no token counts',
      }, null, 2)}\n`, 'utf8');
    }
  } catch { /* diagnostics must never block compaction */ }
}

/** Append-only pass receipt for independent post-hoc verification. */
export function appendPassLog(pass) {
  try {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? '.';
    const dir = join(home, '.dsh', 'continuity');
    mkdirSync(dir, { recursive: true });
    const at = Number.isFinite(pass?.at) ? pass.at : Date.now();
    appendFileSync(join(dir, 'passes.jsonl'), `${JSON.stringify({
      ...pass,
      at: new Date(at).toISOString(),
      atMs: at,
    })}\n`, 'utf8');
    rebuildDroppedRanges(pass?.sessionId ?? null);
  } catch { /* diagnostics must never block compaction */ }
}

/** @typedef {{ at: number, mountedAt: number, policy: object, provenance: object, compactionBasic: object, base: object }} EngineState */
/** @typedef {{ at: number, sessionId?: string, start?: number, end?: number, count?: number, tokens?: number, budget?: number, reason?: string, estTokens?: number, windowTokens?: number, afterTokens?: number, afterSurfaceTokens?: number, afterBaselineTokens?: number, rebloatTokens?: number }} PassRecord */
/** @typedef {{ at: number, sessionId: string, estTokens: number, windowTokens: number, surfaceTokens: number, baselineTokens: number }} ContextRecord */
/** @typedef {{ at: number, sessionId?: string, count: number, tokens: number, chars: number, reason: string }} PreviewRecord */

export const continuityState = {
  /** @type {EngineState | null} */
  engine: null,
  /** The session id the mounted engine has actually served. @type {string|null} */
  engineSession: null,
  /** @type {PassRecord[]} newest first */
  passes: [],
  /** @type {ContextRecord | null} */
  context: null,
  /** @type {PreviewRecord[]} newest first */
  previews: [],
  /** @type {{ at: number, message: string, key?: string } | null} */
  lastError: null,
  /** @type {{ at: number, name: string, scope: string } | null} */
  sessionLogTool: null,
  /** @type {{ at: number, name: string, scope: string } | null} */
  threadsTool: null,
  /** @type {{ at: number, active: string|null, count: number, rules: boolean } | null} */
  threads: null,
};

/** Record that the preset-scoped `session_log` tool registered. */
export function markSessionLogTool({ name, scope }) {
  continuityState.sessionLogTool = { at: Date.now(), name, scope };
}

/** Record that the preset-scoped `continuity` tool registered. */
export function markThreadsTool({ name, scope }) {
  continuityState.threadsTool = { at: Date.now(), name, scope };
}

/** Remember which session the mounted Continuity engine is serving. */
export function markEngineSession(sessionId) {
  const id = typeof sessionId === 'string' ? sessionId : '';
  if (id.length > 0) continuityState.engineSession = id;
}

/** Record the thread injection snapshot for the panel (read-only diagnostic). */
export function markThreadsSnapshot({ activeId, count, rules }) {
  continuityState.threads = {
    at: Date.now(),
    active: activeId ?? null,
    count: Number.isFinite(count) ? count : 0,
    rules: Boolean(rules),
  };
}

/** Record that the engine row mounted, with the policy it resolved. */
export function markEngine({ policy, provenance, compactionBasic, base, instance }) {
  continuityState.engine = {
    at: Date.now(),
    mountedAt: Date.now(),
    policy,
    provenance,
    compactionBasic,
    base: base ?? {},
  };
  // The panel metadata above is not callable; keep the real engine separately
  // so index.apply can route agent/turn-stopping to onTurnStopping.
  continuityState.engineInstance = instance ?? null;
}

/** Remember one completed compaction pass for the panel. */
export function recordPass(pass) {
  const record = { at: Date.now(), ...pass };
  continuityState.passes.unshift(record);
  if (continuityState.passes.length > 24) continuityState.passes.length = 24;
  appendPassLog(record);
}

/** Remember the latest measured context shape (used by stats tail output). */
export function recordContext(context) {
  continuityState.context = { at: Date.now(), ...context };
}

/** Remember one landed batch of old-tool-result previews. */
export function recordPreview(preview) {
  continuityState.previews.unshift({ at: Date.now(), ...preview });
  if (continuityState.previews.length > 24) continuityState.previews.length = 24;
}

/** Remember the last non-fatal measurement or compaction failure. */
export function recordError(message, key) {
  continuityState.lastError = { at: Date.now(), message: String(message), ...(key === undefined ? {} : { key }) };
}

export function resetState() {
  continuityState.engine = null;
  continuityState.engineInstance = null;
  continuityState.engineSession = null;
  continuityState.passes = [];
  continuityState.context = null;
  continuityState.previews = [];
  continuityState.lastError = null;
  continuityState.sessionLogTool = null;
  continuityState.threadsTool = null;
  continuityState.threads = null;
}

export default continuityState;
