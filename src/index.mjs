/**
 * dsh-continuity — Host half.
 *
 * This row is the plugin's visible face: it serves the small JSON snapshot the
 * left-sidebar panel reads. It does not replace `ctx.compaction`; the engine is
 * mounted inside the `continuity` agent preset (see cordis.patch.yml), where the
 * one compaction service per context can be replaced safely.
 *
 * The snapshot is diagnostic only: policy values, the last recorded passes,
 * the provenance convention, the measured runtime API facts, and a projection
 * of the config-only experiment for the configured model route.
 */
import { createRequire } from 'node:module';
import { appendFileSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadActiveIndex } from './fullseed/cache.mjs';
import { continuityHome } from './folds-store.mjs';
import { DEFAULT_POLICY } from './policy.mjs';
import { SYSTEM_CONVENTION, gistHeader } from './provenance.mjs';
import { continuityState, rebuildDroppedRanges } from './state.mjs';
import { buildFacetState } from './facets/panel-state.mjs';
import { migrateThreadsFile } from './threads-store.mjs';
import { installExtractionPreStep, recordExtractionInstallError, lastUserText } from './memory/extraction-pre-step.mjs';
import { contextMessage } from './threads.mjs';
import { installTurnPing, recordTurnPingInstallIssue } from './turn-ping/install.mjs';
import { resolveTurnPingConfig } from './turn-ping/local-config.mjs';
import { turnPingBeforeAnswer, getTurnPingHost } from './turn-ping/registry.mjs';
import { installTurnPingPreStep } from './turn-ping/pre-step.mjs';
import { installRawIndexHost } from './turn-ping/raw-index-host.mjs';
import { wireCoverageHost } from './turn-ping/coverage/host-wire.mjs';
import { installEngineTurnStopping } from './fullseed/worker.mjs';
import { createFullseedWorker, workerIdentityFromConfig } from './fullseed/runtime.mjs';
import { createHostRebuildService } from './fullseed/host-rebuild.mjs';
import { setHostRebuildService, setHostRebuildUnavailable } from './fullseed/host-rebuild-tool.mjs';
import { turnPingRoot } from './turn-ping/storage.mjs';
import { createLlmSummaryProvider, createBgeEmbedder } from './turn-ping/host-adapters.mjs';
import { createFullseedLlmProvider } from './fullseed/llm-adapter.mjs';
import { installBCPreStep } from './memory/bc-pre-step.mjs';
import { buildBCPanelState } from './memory/bc-panel-state.mjs';
import { isPersonaEnabled, resolvePersona, sessionFile } from './memory/persona.mjs';
import { installSessionGuard } from './session-guard.mjs';
import { createRecallExactTool } from './recall-exact-tool.mjs';
import { createMemoryRepairTool } from './memory/memory-repair-tool.mjs';
import { createConceptTrialTool } from './memory/concept-trial-tool.mjs';
import { createConceptProposeTool } from './memory/concept-propose-tool.mjs';

export const name = 'dsh-continuity';
export const inject = ['sessionQuery'];

const require = createRequire(import.meta.url);
let pkg = {};
try {
  pkg = require('../package.json');
} catch {
  pkg = {};
}

const DEFAULT_PATH = '/dsh-continuity/state.json';
/** The shipped compaction-basic default; the quick-win config also keeps it. */
const HEADROOM_TOKENS = 65_536;
/** Adapter defaults verified in the installed `dsh-llm-deepseek` source. */
const FALLBACK_WINDOW = { contextWindow: 1_000_000, defaultMaxTokens: 256_000 };

/** Measured at runtime through `cordis_inspect_query` on the live 0.2.1-rc.3 Host. */
const FACTS = [
  {
    label: 'compaction row (host)',
    value: 'include:compaction-basic · patchId compaction-basic · enabled=false in the desktop profile',
  },
  {
    label: 'compaction row (live)',
    value: 'include:preset-standard → group compaction (isolate: compaction, toolResultPruner) → child compaction-basic',
  },
  {
    label: 'token meter',
    value: 'ctx.tokenMeter.measure(session, requestHeader?) → { totalTokens, surfaceTokens, nodes[{ seq, tokens, heuristicTokens }], baseline, logRevision }',
  },
  {
    label: 'session surface',
    value: 'session.surface.nodes: readonly SessionSeq[] · session.eventAt(seq) · session.deriveEventMessage(event) · session.requestHeader()',
  },
  {
    label: 'model window',
    value: 'ctx.llm.resolveModelInfo(provider, model) → { context.contextWindow, defaultMaxTokens }',
  },
  {
    label: 'summary result',
    value: 'summarize() → { summary: ContentBlock[], provider, model, maxTokens, usage? }',
  },
  {
    label: 'pairing predicates',
    value: 'toolPairingBalancedBefore(session, seq) · toolPairingBalancedAfter(session, seq)',
  },
  {
    label: 'system section',
    value: 'ctx.systemPrompt.section({ name, order, text, interpolate })',
  },
  {
    label: 'retrieval tool',
    value: 'session_log index / get / grep / stats → readSession + live tokenMeter · read-only · preset-scoped',
  },
  {
    label: 'thread tool',
    value: 'continuity save / load / active / list → validated surface range + append-only [thread] gist · preset-scoped',
  },
  {
    label: 'thread injection',
    value: 'per-turn user/message after the surface tail (active line + user rules.md) · never in the system/tool prefix',
  },
];

export function apply(ctx, config = {}) {
  const log = ctx.logger ?? console;
  try { rebuildDroppedRanges(); } catch (error) {
    try { log.warn?.(`dsh-continuity: dropped-ranges rebuild skipped: ${error?.message ?? error}`); } catch { /* ignore */ }
  }
  try { installSessionGuard(ctx); } catch (error) {
    try { log.warn?.(`dsh-continuity: session guard not installed: ${error?.message ?? error}`); } catch { /* ignore */ }
  }
  try {
    const coverage = config.turnPing?.coverage ?? {};
    const home = coverage.home || join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity');
    const coverageProvider = coverage.useHostAdapters === true && typeof coverage.provider === 'string' && typeof coverage.model === 'string'
      ? createLlmSummaryProvider({ llm: typeof ctx.get === 'function' ? ctx.get('llm') : null, provider: coverage.provider, model: coverage.model })
      : null;
    const coverageEmbedder = coverage.useHostAdapters === true && typeof coverage.embeddingModel === 'string'
      ? createBgeEmbedder({ model: coverage.embeddingModel })
      : null;
    const wired = wireCoverageHost({ ctx, config: coverage, home, provider: coverageProvider, embedder: coverageEmbedder });
    if (wired.wired) log.info?.('[dsh-continuity] coverage host wired (agent/created, session/created, session/event)');
    else if (wired.reason !== 'disabled') log.warn?.(`[dsh-continuity] coverage host not wired: ${wired.reason}`);
  } catch (error) {
    log.warn?.(`[dsh-continuity] coverage host wiring failed: ${error?.message ?? error}`);
  }
  // One-shot: old backfill rows stored the write moment in `at`; normalize the
  // file too, not only the in-memory view, so direct threads.json readers agree.
  try {
    void migrateThreadsFile({ log }).catch((error) => {
      try { log.warn?.(`[dsh-continuity] threads normalization failed: ${error?.message ?? error}`); } catch { /* ignore */ }
    });
  } catch (error) {
    try { log.warn?.(`[dsh-continuity] threads normalization failed: ${error?.message ?? error}`); } catch { /* ignore */ }
  }
  // ABCK is legacy. Its tools are not part of the 5.0.0 runtime; code remains
  // for historical rollback only.
  const legacyAbcK = config.legacyAbcK === true;
  if (legacyAbcK) {
    ctx.inject(['tools', 'sessionQuery'], (scoped) => {
      const tool = createRecallExactTool({ sessionQuery: scoped.sessionQuery });
      scoped.effect(() => scoped.tools.register(tool));
    });
    ctx.inject(['tools'], (scoped) => {
      const tool = createMemoryRepairTool();
      scoped.effect(() => scoped.tools.register(tool));
      const trial = createConceptTrialTool();
      scoped.effect(() => scoped.tools.register(trial));
      const propose = createConceptProposeTool();
      scoped.effect(() => scoped.tools.register(propose));
    });
  } else {
    log.info?.('[dsh-continuity] legacy ABCK tools disabled (5.0.0 runtime)');
  }
  // Extraction is opt-in by config or environment. Default off means this
  // listener is never registered, so the normal turn path is byte-for-byte unchanged.
  try {
    const extraction = config.extraction ?? {};
    const extractionEnv = { ...process.env, ...(extraction.env ?? {}) };
    if (typeof extraction.mode === 'string') extractionEnv.DSH_EXTRACTION_MODE = extraction.mode;
    if (typeof extraction.config === 'string') extractionEnv.DSH_EXTRACTION_CONFIG = extraction.config;
    if (typeof extraction.cache === 'string') extractionEnv.DSH_EXTRACTION_CACHE = extraction.cache;
    const sessionQuery = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : ctx.sessionQuery;
    const installed = installExtractionPreStep(ctx, extractionEnv, { sessionQuery });
    if (installed.registered) log.info?.(`[dsh-continuity] extraction pre-step registered (${installed.mode})`);
    else if (installed.error) recordExtractionInstallError(installed.error, { home: process.env.USERPROFILE ?? process.env.HOME ?? '', log });
  } catch (error) {
    try {
      appendFileSync(join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity', 'gate-errors.jsonl'), JSON.stringify({
        at: new Date().toISOString(), name: error?.name ?? 'Error', code: 'extraction-pre-step-register',
        message: String(error?.message ?? error),
      }) + '\n', 'utf8');
    } catch { /* registration failure must not block the plugin */ }
  }
  try {
    const bc = config.bcRecall ?? {};
    if (bc.enabled === true) {
      const installed = installBCPreStep(ctx, {
        enabled: true,
        storePath: typeof bc.store === 'string' ? bc.store : null,
        prefix: typeof bc.prefix === 'string' ? bc.prefix : '',
        sessionQuery: typeof ctx.get === 'function' ? ctx.get('sessionQuery') : ctx.sessionQuery,
      });
      if (installed.registered) log.info?.(`[dsh-continuity] B+C pre-step registered (${installed.records} records) indexUpdater=${installed.indexUpdater} sessionQuery=${installed.sessionQuery} store=${installed.store}`);
    } else {
      log.info?.('[dsh-continuity] B+C pre-step disabled by config');
    }
  } catch (error) {
    try {
      appendFileSync(join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity', 'gate-errors.jsonl'), JSON.stringify({
        at: new Date().toISOString(), name: error?.name ?? 'Error', code: 'bc-pre-step-register',
        message: String(error?.message ?? error),
      }) + '\n', 'utf8');
    } catch { /* registration failure must not block the plugin */ }
  }
  let resolvedTurnPing = null;
  try {
    const turnPing = resolveTurnPingConfig(config.turnPing ?? {}, { home: continuityHome() });
    resolvedTurnPing = turnPing;
    const llm = typeof ctx.get === 'function' ? ctx.get('llm') : null;
    const summaryProvider = typeof turnPing.provider === 'function'
      ? turnPing.provider
      : (turnPing.useHostAdapters === true && typeof turnPing.provider === 'string' && typeof turnPing.model === 'string'
        ? createLlmSummaryProvider({ llm, provider: turnPing.provider, model: turnPing.model })
        : null);
    const embeddingAdapter = typeof turnPing.embedder === 'function'
      ? turnPing.embedder
      : (turnPing.useHostAdapters === true && typeof turnPing.embeddingModel === 'string'
        ? createBgeEmbedder({ model: turnPing.embeddingModel })
        : null);
    const installed = installTurnPing({
      config: turnPing,
      provider: summaryProvider,
      embedder: embeddingAdapter,
    });
    if (installed.enabled) {
      log.info?.(`[dsh-continuity] turn-ping host enabled (${installed.home})`);
      const allowedSessions = Array.isArray(turnPing.sessionIds) ? new Set(turnPing.sessionIds.map(String)) : null;
      if (turnPing.fullseedEnqueue === true) {
        installEngineTurnStopping({
          ctx,
          rootForSession: (sessionId) => `${turnPingRoot({ home: installed.home, sessionId })}/fullseed`,
          allowedSessionIds: allowedSessions,
        });
      }
      const fullseedProvider = (turnPing.fullseedWorker === true && typeof turnPing.provider === 'string' && typeof turnPing.model === 'string' && llm)
        ? createFullseedLlmProvider({ llm, provider: turnPing.provider, model: turnPing.model })
        : null;
      if (turnPing.fullseedWorker === true && fullseedProvider && embeddingAdapter && typeof ctx.get === 'function' && ctx.get('sessionQuery')) {
        createFullseedWorker({
          home: installed.home,
          sessionQuery: ctx.get('sessionQuery'),
          provider: fullseedProvider,
          embedder: embeddingAdapter,
          identity: workerIdentityFromConfig(turnPing),
          allowedSessionIds: allowedSessions,
          log: (row) => log.info?.(`[dsh-continuity] fullseed worker ${JSON.stringify(row)}`),
        });
      }
      const sessionQuery = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : null;
      if (turnPing.useHostAdapters === true && llm && embeddingAdapter && sessionQuery) {
        setHostRebuildService(createHostRebuildService({
          home: installed.home,
          sessionQuery,
          provider: createFullseedLlmProvider({ llm, provider: turnPing.provider, model: turnPing.model }),
          embedder: embeddingAdapter,
          allowedSessionIds: allowedSessions,
          providerName: turnPing.provider,
          model: turnPing.model,
        }));
        log.info?.('[dsh-continuity] Host memory_rebuild service ready (ctx.llm)');
      } else {
        const missing = [];
        if (turnPing.useHostAdapters !== true) missing.push('useHostAdapters');
        if (!llm) missing.push('ctx.llm');
        if (!embeddingAdapter) missing.push('embedder');
        if (!sessionQuery) missing.push('sessionQuery');
        const message = `memory_rebuild prerequisites unavailable: ${missing.join(', ')}`;
        const code = 'host-rebuild-prerequisites-unavailable';
        setHostRebuildUnavailable({ code, message });
        recordTurnPingInstallIssue({ home: installed.home, config: turnPing, code, reason: message, log });
      }
      installTurnPingPreStep({
        ctx,
        config: turnPing,
        beforeAnswer: turnPingBeforeAnswer,
        contextMessage,
        log,
        diagnosticPath: installed.diagnosticPath,
      });
      installRawIndexHost({
        ctx,
        config: turnPing,
        home: installed.home,
        diagnosticPath: installed.diagnosticPath,
        indexFor: installed.host.rawIndexFor,
      });
    } else if (installed.reason === 'disabled') {
      setHostRebuildUnavailable({ code: 'turn-ping-disabled', message: 'memory resonance is disabled by local configuration' });
    } else {
      const code = `turn-ping-${installed.reason}`;
      const message = `turn-ping not installed: ${installed.reason}`;
      setHostRebuildUnavailable({ code, message });
      recordTurnPingInstallIssue({ home: turnPing.home || continuityHome(), config: turnPing, code, reason: message, log });
    }
  } catch (error) {
    const code = 'turn-ping-install-failed';
    const message = String(error?.message ?? error);
    const turnPing = resolvedTurnPing ?? config.turnPing ?? {};
    setHostRebuildUnavailable({ code, message });
    recordTurnPingInstallIssue({ home: turnPing.home || continuityHome(), config: turnPing, code, error, log });
  }
  // First history-map injection must not wait for compression pressure.
  try {
    ctx.on('agent/pre-step', async (payload, next) => {
      try {
        const engine = continuityState.engineInstance;
        if (engine !== null && typeof engine?.ensureHistoryMap === 'function') {
          await engine.ensureHistoryMap(payload?.agent);
        }
      } catch (error) {
        try {
          log.warn?.(`[dsh-continuity] history-map bootstrap skipped: ${error?.message ?? error}`);
        } catch { /* logging only */ }
      }
      return next();
    });
  } catch (error) {
    try {
      log.warn?.(`[dsh-continuity] history-map pre-step registration failed: ${error?.message ?? error}`);
    } catch { /* ignore */ }
  }
  const panel = config.panel ?? {};
  if (panel.enabled === false) {
    log.info?.('[dsh-continuity] panel disabled by config; no route registered');
    return;
  }

  const path = typeof panel.path === 'string' && panel.path.startsWith('/') ? panel.path : DEFAULT_PATH;
  const projectionConfig = {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    ...(config.projection ?? {}),
  };
  const cache = { key: '', at: 0, value: null };
  const scopeCache = { at: 0, value: [] };
  const queryCache = { at: 0, value: null };

  const route = {
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' });
        res.end();
        return;
      }
      let payload;
      try {
        payload = await buildSnapshot(ctx, path, projectionConfig, cache, scopeCache, queryCache);
      } catch (error) {
        payload = { error: String(error?.message ?? error), generatedAt: new Date().toISOString() };
      }
      const text = JSON.stringify(payload, null, 2);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(text),
      });
      if (req.method === 'HEAD') res.end();
      else res.end(text);
    },
  };

  // Do not read `ctx.get('webServer')` here: on a cold start this row may
  // activate before the Web server publishes its service, and the early return
  // would leave the row active with no route (the exact bug seen after a
  // restart). `ctx.inject` registers the route as soon as the service is up,
  // and disposes it with the plugin.
  // Legacy `/dsh-continuity/tags.json` is intentionally not registered.
  // The safe UI reads B/C/K from `/dsh-continuity/bc.json` only.

  const bcPath = '/dsh-continuity/bc.json';
  const requestSessionId = (req) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const query = url.searchParams.get('sessionId');
      if (query) return query;
    } catch { /* ignore */ }
    const referer = String(req.headers?.referer ?? '');
    const match = referer.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return match ? match[0] : null;
  };
  const bcRoute = {
    kind: 'exact',
    path: bcPath,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' });
        res.end();
        return;
      }
      let payload;
      try {
        const sessionId = requestSessionId(req);
        const home = process.env.USERPROFILE ?? process.env.HOME;
        if (!sessionId) {
          payload = { available: false, error: 'session-id-required', generatedAt: new Date().toISOString() };
        } else {
          const personaId = resolvePersona(sessionId, home);
          if (!isPersonaEnabled(personaId, home)) {
            payload = { available: false, error: 'persona-disabled', personaId, generatedAt: new Date().toISOString() };
          } else {
            const sessionDir = join(home, '.dsh', 'continuity', 'sessions', sessionId);
            payload = buildBCPanelState({
              file: process.env.DSH_BC_INDEX ?? join(sessionDir, 'bc-index.jsonl'),
              home,
              conceptsFile: sessionFile(sessionId, 'concepts.md', home),
              keywordsFile: sessionFile(sessionId, 'keywords.md', home),
              cmapFile: sessionFile(sessionId, 'cmap.md', home),
            });
          }
        }
      } catch (error) {
        payload = { available: false, error: String(error?.message ?? error), generatedAt: new Date().toISOString() };
      }
      const text = JSON.stringify(payload, null, 2);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(text),
      });
      if (req.method === 'HEAD') res.end();
      else res.end(text);
    },
  };

  const facetsPath = '/dsh-continuity/facets.json';
  const facetsRoute = {
    kind: 'exact',
    path: facetsPath,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' });
        res.end();
        return;
      }
      let payload;
      try {
        payload = buildFacetState();
      } catch (error) {
        payload = { available: false, error: String(error?.message ?? error), generatedAt: new Date().toISOString() };
      }
      const text = JSON.stringify(payload, null, 2);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(text),
      });
      if (req.method === 'HEAD') res.end();
      else res.end(text);
    },
  };

  const currentPath = '/dsh-continuity/current.json';
  const currentRoute = {
    kind: 'exact',
    path: currentPath,
    handler: createCurrentStateHandler(ctx, () => ({ turnPing: resolvedTurnPing })),
  };

  const switchPath = '/dsh-continuity/switch-to-continuity';
  const readJsonBody = async (req) => {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 100_000) throw new Error('request body too large');
    }
    return raw.trim() === '' ? {} : JSON.parse(raw);
  };
  const switchRoute = {
    kind: 'exact',
    path: switchPath,
    handler: async (req, res) => {
      const send = (status, payload) => {
        const text = JSON.stringify(payload, null, 2);
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(text),
        });
        res.end(text);
      };
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' });
        res.end();
        return;
      }
      try {
        const body = await readJsonBody(req);
        const sessionId = String(body?.sessionId ?? '').trim();
        if (!sessionId) return send(400, { ok: false, error: 'sessionId required' });
        const registry = ctx.get('agents');
        const presets = ctx.get('agentPresets');
        if (!registry || typeof registry.list !== 'function') return send(503, { ok: false, error: 'agents service unavailable' });
        if (!presets || typeof presets.select !== 'function') return send(503, { ok: false, error: 'agentPresets service unavailable' });
        const agents = registry.list();
        const agent = agents.find((item) => String(item?.session?.id) === sessionId)
          ?? agents.find((item) => String(item?.id) === sessionId);
        if (!agent) return send(404, { ok: false, error: 'live session not found', sessionId });
        const before = agent?.session?.header?.agentPreset ?? null;
        const after = await presets.select(agent, 'continuity');
        return send(200, { ok: true, sessionId, before, after });
      } catch (error) {
        return send(500, { ok: false, error: String(error?.message ?? error) });
      }
    },
  };

  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(() => scoped.webServer.register(route));
    scoped.effect(() => scoped.webServer.register(currentRoute));
    scoped.effect(() => scoped.webServer.register(bcRoute));
    scoped.effect(() => scoped.webServer.register(facetsRoute));
    scoped.effect(() => scoped.webServer.register(switchRoute));
    scoped.logger?.info?.(`[dsh-continuity] control panel mounted at ${path} (bc: ${bcPath}, facets: ${facetsPath})`);
  });
}

export function createCurrentStateHandler(ctx, getRuntime = () => ({})) {
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end();
      return;
    }
    let payload;
    try {
      payload = await buildCurrentState(ctx, sessionIdFromRequest(req), getRuntime());
    } catch (error) {
      payload = { error: String(error?.message ?? error), generatedAt: new Date().toISOString() };
    }
    const text = JSON.stringify(payload, null, 2);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    });
    if (req.method === 'HEAD') res.end();
    else res.end(text);
  };
}

function sessionIdFromRequest(req) {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const query = url.searchParams.get('sessionId');
    if (query) return query;
  } catch { /* ignore */ }
  const referer = String(req.headers?.referer ?? '');
  const match = referer.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match ? match[0] : null;
}

export async function buildCurrentState(ctx, requestedSessionId = null, runtime = {}) {
  const home = continuityHome();
  const agents = ctx?.get?.('agents')?.list?.() ?? [];
  const projections = ctx?.get?.('sessionProjections');
  const agent = requestedSessionId
    ? agents.find((item) => String(item?.session?.id ?? item?.id) === String(requestedSessionId))
    : agents.find((item) => currentPresetOf(item, projections) === 'continuity') ?? agents[0] ?? null;
  const sessionId = agent === null ? null : String(agent.session?.id ?? agent.id ?? '');
  const preset = agent === null ? null : currentPresetOf(agent, projections);
  const engine = continuityState.engine;
  const engineInstance = continuityState.engineInstance ?? null;
  const lastError = continuityState.lastError;
  const engineSession = continuityState.engineSession ?? null;
  const engineMounted = engine !== null && engineSession !== null && String(engineSession) === String(sessionId);
  const engineScope = engine === null ? 'none' : engineMounted ? 'session' : engineSession === null ? 'unknown' : 'other-session';
  const current = {
    generatedAt: new Date().toISOString(),
    plugin: { name: pkg.name ?? 'dsh-continuity', version: pkg.version ?? '0.0.0', packageHash: process.env.DSH_CONTINUITY_PACKAGE_SHA ?? null },
    session: { id: sessionId, preset, engineMounted, engineScope, lastError: null },
    memoryResonance: { configured: false, enabled: false, allowed: null, active: false, readiness: 'unknown', summaries: 0, vectors: 0, checkpoint: null, availableCutoff: null, latestCue: null, retrieval: { status: 'not-observed' }, rawRead: { status: 'not-observed' } },
    unifiedFold: { configured: false, enabled: false, sessionAllowed: false, lastFold: null, reinjection: 'not-observed', pending: 'not-observed', recovered: 'not-observed', error: null },
    migration: { plan: null, audit: null, reusable: null, missing: null, budget: null, resume: null, verify: null, legacyActivePreserved: null },
    diagnostics: { version: pkg.version ?? '0.0.0', packageHash: process.env.DSH_CONTINUITY_PACKAGE_SHA ?? null, node: process.version, hostServices: {}, errors: lastError ? [String(lastError.message ?? lastError)] : [], globalError: lastError ?? null },
  };
  if (!sessionId) return current;

  try {
    const root = join(home, 'sessions', sessionId, 'turn-ping', 'fullseed');
    const index = loadActiveIndex(root);
    const config = runtime.turnPing ?? null;
    const configured = config !== null;
    const allowed = configured && Array.isArray(config.sessionIds) && config.sessionIds.map(String).includes(String(sessionId));
    const summaries = index?.merged?.summaries ?? [];
    const vectors = index?.merged?.vectors ?? [];
    const cutoff = summaries.reduce((max, row) => Math.max(max, Number(row.availableCutoff) || 0), 0);
    current.memoryResonance = {
      configured,
      enabled: configured && config.enabled === true && allowed,
      allowed: configured ? allowed : null,
      active: index !== null,
      readiness: index === null ? 'no-active' : 'active',
      summaries: summaries.length,
      vectors: vectors.length,
      checkpoint: index?.active?.checkpoint ?? null,
      availableCutoff: cutoff || null,
      latestCue: readLatestCue(home, sessionId),
      retrieval: ctx?.get?.('sessionQuery') ? { status: 'service-available', scope: 'interface', available: null } : { status: 'unavailable', available: false },
      rawRead: ctx?.get?.('sessionQuery') ? { status: 'service-available', scope: 'interface', available: null } : { status: 'unavailable', available: false },
    };
  } catch (error) {
    current.memoryResonance.error = String(error?.message ?? error);
    current.diagnostics.errors.push(`memory: ${String(error?.message ?? error)}`);
  }

  try {
    const fold = engineInstance?.unifiedFold ?? runtime.unifiedFold ?? null;
    const allowed = fold?.sessionIds === null || fold?.sessionIds === undefined ? false : fold.sessionIds.has(sessionId);
    const last = Array.isArray(continuityState.passes)
      ? continuityState.passes.find((row) => String(row.sessionId) === String(sessionId)) ?? null
      : null;
    current.unifiedFold = {
      configured: Boolean(fold),
      enabled: Boolean(fold) && Boolean(allowed),
      sessionAllowed: Boolean(allowed),
      engineSession: continuityState.engineSession ?? null,
      lastFold: last ? { selected: last.count ?? null, completed: last.completed ?? null, range: [last.start ?? null, last.end ?? null], at: last.at ?? null } : null,
      reinjection: 'not-observed',
      pending: 'not-observed',
      recovered: 'not-observed',
      error: current.diagnostics.errors.find((line) => line.startsWith('fold:')) ?? null,
    };
  } catch (error) {
    current.diagnostics.errors.push(`fold: ${String(error?.message ?? error)}`);
  }

  try {
    const dir = join(home, 'sessions', sessionId, 'migration');
    const plans = existsSync(dir)
      ? readdirSync(dir).filter((name) => /^plan-.*\.json$/.test(name)).map((name) => ({ name, file: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs }))
      : [];
    if (plans.length > 0) {
      const file = plans.sort((left, right) => right.mtime - left.mtime)[0].file;
      const plan = JSON.parse(readFileSync(file, 'utf8'));
      const verify = readVerifyResult(dir);
      const staging = readStagingState(join(home, 'sessions', sessionId, 'turn-ping', 'fullseed'));
      current.migration = {
        plan: { file, contentSha256: plan.contentSha256 ?? null, status: plan.status ?? null, checkpoint: plan.checkpoint ?? null },
        audit: { missing: plan.missing ?? null, reusable: plan.reusable ?? null, chunks: plan.chunkSet?.count ?? null },
        reusable: plan.reusable ?? null,
        missing: plan.missing ?? null,
        budget: plan.budget ?? null,
        staging,
        resume: staging ? { state: 'staging-present-unverified', pending: 'unknown' } : { state: plan.status === 'plan-only-no-apply' ? 'not-approved' : plan.status ?? 'unknown' },
        verify,
        legacyActivePreserved: plan.active?.legacy?.preserved ?? null,
      };
    }
  } catch (error) {
    current.diagnostics.errors.push(`migration: ${String(error?.message ?? error)}`);
  }

  current.diagnostics.hostServices = {
    agents: Boolean(ctx?.get?.('agents')),
    sessionQuery: Boolean(ctx?.get?.('sessionQuery')),
    sessionProjections: Boolean(ctx?.get?.('sessionProjections')),
    locale: (() => { try { return Boolean(ctx?.locale); } catch { return false; } })(),
    slots: (() => { try { return Boolean(ctx?.slots); } catch { return false; } })(),
  };
  return current;
}

function readStagingState(root) {
  try {
    const dir = join(root, 'staging');
    if (!existsSync(dir)) return null;
    let summaries = 0;
    let vectors = 0;
    let attempts = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const base = join(dir, entry.name);
      if (existsSync(join(base, 'summaries.jsonl'))) summaries += readFileSync(join(base, 'summaries.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).length;
      if (existsSync(join(base, 'vectors.jsonl'))) vectors += readFileSync(join(base, 'vectors.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).length;
      if (existsSync(join(base, 'attempts.jsonl'))) attempts += readFileSync(join(base, 'attempts.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).length;
    }
    return { summaries, vectors, attempts, pending: 'unknown' };
  } catch { return null; }
}

function readLatestCue(home, sessionId) {
  try {
    const file = join(home, 'turn-ping-prestep-debug.jsonl');
    if (!existsSync(file)) return null;
    const rows = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    const owned = rows.filter((row) => String(row.sessionId ?? '') === String(sessionId));
    const returned = owned.filter((row) => row.kind === 'return' && row.appended === true).at(-1);
    if (returned) return { at: returned.at ?? null, kind: 'return', source: returned.lastSourceKind ?? null, hash: returned.lastTextSha256 ?? null };
    return null;
  } catch { return null; }
}

function readVerifyResult(dir) {
  try {
    const file = readdirSync(dir).filter((name) => /^verify-.*\.json$/.test(name)).sort().at(-1);
    if (!file) return null;
    const row = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    return { ok: row.ok === true, chunks: row.chunks ?? null, at: row.at ?? null };
  } catch { return null; }
}

export function buildGlobalPanelExtras(ctx, scopes, projection) {
  const host = getTurnPingHost();
  const errors = continuityState.lastError ? [continuityState.lastError] : [];
  const ids = Array.isArray(host?.config?.sessionIds) ? host.config.sessionIds.map(String) : [];
  const home = host?.home ?? continuityHome();
  let vectors = 0;
  let rawRecords = 0;
  let reconciledSessions = 0;
  if (host) {
    for (const sessionId of ids) {
      try {
        const active = loadActiveIndex(join(turnPingRoot({ home, sessionId }), 'fullseed'));
        vectors += active?.merged?.vectors?.length ?? 0;
      } catch (error) {
        errors.push({ at: Date.now(), message: `vector status ${sessionId}: ${String(error?.message ?? error)}` });
      }
      try {
        const status = host.rawIndexFor(sessionId).status();
        rawRecords += status.records;
        if (status.lastReconcile) reconciledSessions += 1;
      } catch (error) {
        errors.push({ at: Date.now(), message: `raw index ${sessionId}: ${String(error?.message ?? error)}` });
      }
    }
  }
  const runtime = {
    model: {
      provider: projection?.provider ?? null,
      model: projection?.model ?? null,
      metadataResolved: projection?.available === true,
    },
    bge: {
      model: host?.config?.vector?.model ?? null,
      vectors,
      status: host ? (vectors > 0 ? 'vectors-present' : 'not-observed') : 'disabled',
    },
    writeIndex: {
      enabled: host?.config?.enabled === true && host.config.rawIndex?.enabled !== false,
      records: rawRecords,
      reconciledSessions,
    },
    authorizedSessions: ids.length,
    recentErrors: errors.slice(-5),
  };
  // The catalog is package documentation, not a live-only observation. Always
  // list the tools this package can provide; observed schemas only add status.
  const byName = new Map([...PANEL_TOOL_NAMES].map((name) => [name, {
    name, description: '', parameters: null, visibleSessions: new Set(),
  }]));
  let observed = false;
  for (const scope of scopes ?? []) {
    if (scope?.toolDetailsObserved === true) observed = true;
    for (const tool of scope?.toolDetails ?? []) {
      if (!byName.has(tool.name)) byName.set(tool.name, { ...tool, visibleSessions: new Set() });
      if (scope.sessionId) byName.get(tool.name).visibleSessions.add(scope.sessionId);
    }
  }
  const tools = [...byName.values()].map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    visibleSessions: tool.visibleSessions.size,
  })).sort((a, b) => a.name.localeCompare(b.name));
  return { runtime, toolCatalog: { observed, tools } };
}

async function buildSnapshot(ctx, path, projectionConfig, cache, scopeCache, queryCache) {
  const engine = continuityState.engine;
  const policy = engine?.policy ?? DEFAULT_POLICY;
  const presets = await listPresets(ctx);
  const projection = await projectWindow(ctx, projectionConfig, cache, policy);
  const scopes = await inspectScopes(ctx, scopeCache);
  const sessionQuery = await probeSessionQuery(ctx, queryCache);
  const extras = buildGlobalPanelExtras(ctx, scopes, projection);

  return {
    legacy: true,
    runtime: extras.runtime,
    toolCatalog: extras.toolCatalog,
    replacement: '/dsh-continuity/current.json',
    plugin: { name: pkg.name ?? 'dsh-continuity', version: pkg.version ?? '0.0.0' },
    generatedAt: new Date().toISOString(),
    panel: { path },
    engine: engine === null ? null : {
      mountedAt: engine.mountedAt,
      policy: engine.policy,
      provenance: engine.provenance,
      compactionBasic: engine.compactionBasic,
      base: engine.base,
    },
    passes: continuityState.passes,
    context: continuityState.context,
    previews: continuityState.previews,
    lastError: continuityState.lastError,
    presets,
    tools: {
      sessionLog: continuityState.sessionLogTool,
      threads: continuityState.threadsTool,
      threadsState: continuityState.threads,
      scopes,
    },
    sessionQuery,
    provenance: {
      convention: SYSTEM_CONVENTION,
      sample: gistHeader({ sessionId: 'session-…', startSeq: 120, endSeq: 154, count: 34 }),
      labels: ['[verbatim]', '[gist]', '[uncertain]', '[open]'],
    },
    projection,
    facts: FACTS,
  };
}

/** Current preset: the `agentPreset` projection, falling back to the creation header. */
function currentPresetOf(agent, projections) {
  const headerPreset = agent?.session?.header?.agentPreset ?? null;
  try {
    const projected = projections?.stateOf?.(agent.session, 'agentPreset');
    if (projected !== undefined) return projected;
  } catch {
    return headerPreset;
  }
  return headerPreset;
}

/**
 * Verify the exact-read Host API used by `session_log` before the tool row is
 * mounted: read the live Continuity session through `ctx.sessionQuery`.
 * Cached; this is a diagnostic, not a per-poll replay.
 */
async function probeSessionQuery(ctx, cache) {
  if (Date.now() - cache.at < 30_000) return cache.value;
  const query = ctx.get('sessionQuery');
  if (query === undefined) {
    cache.value = { available: false, reason: 'sessionQuery service unavailable' };
    cache.at = Date.now();
    return cache.value;
  }
  const projections = ctx.get('sessionProjections');
  const agents = ctx.get('agents')?.list?.() ?? [];
  const continuity = agents.find((agent) => currentPresetOf(agent, projections) === 'continuity');
  if (continuity === undefined) {
    cache.value = { available: true, sessionId: null, reason: 'no live continuity agent' };
    cache.at = Date.now();
    return cache.value;
  }
  const sessionId = String(continuity.session.id);
  try {
    const snapshot = await query.readSession(continuity.session.id);
    const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
    cache.value = {
      available: true,
      source: 'ctx.sessionQuery.readSession',
      sessionId,
      events: events.length,
      firstSeq: events[0]?.seq ?? null,
      lastSeq: events.at(-1)?.seq ?? null,
    };
  } catch (error) {
    cache.value = {
      available: true,
      source: 'ctx.sessionQuery.readSession',
      sessionId,
      error: String(error?.message ?? error),
    };
  }
  cache.at = Date.now();
  return cache.value;
}

/**
 * Verify the preset-scoped capability without asking the model: which live
 * agents see `session_log`, and which see the convention section. Cached: the
 * prompt assembly is the expensive part and the panel polls every few seconds.
 */
const PANEL_TOOL_NAMES = new Set(['memory_rebuild', 'memory_recall', 'read_seq_range', 'read_raw_chunk', 'session_asset', 'child_asset', 'ptc_handoff']);

async function inspectScopes(ctx, cache) {
  if (Date.now() - cache.at < 15_000) return cache.value;
  const tools = ctx.get('tools');
  const prompts = ctx.get('systemPrompt');
  const projections = ctx.get('sessionProjections');
  const agents = ctx.get('agents')?.list?.() ?? [];
  const value = [];
  for (const agent of agents.slice(0, 8)) {
    const sessionId = agent?.id === undefined ? null : String(agent.id);
    const headerPreset = agent?.session?.header?.agentPreset ?? null;
    const preset = currentPresetOf(agent, projections);
    const schemas = typeof tools?.schemas === 'function' ? tools.schemas(agent) ?? [] : [];
    const toolNames = schemas.map((tool) => tool.name);
    const toolDetails = schemas.filter((tool) => PANEL_TOOL_NAMES.has(tool?.name))
      .map((tool) => ({ name: tool.name, description: tool.description ?? '', parameters: tool.parameters ?? tool.inputSchema ?? null }));
    let convention = null;
    if (preset === 'continuity' && prompts !== undefined) {
      try {
        const assembly = await prompts.assemble({ scope: agent });
        convention = (assembly?.sections ?? []).some((section) => section.name === 'continuity:provenance');
      } catch {
        convention = null;
      }
    }
    value.push({
      sessionId,
      preset,
      presetHeader: headerPreset,
      sessionLog: toolNames.includes('session_log'),
      threads: toolNames.includes('continuity'),
      convention,
      toolCount: toolNames.length,
      toolDetails,
      toolDetailsObserved: typeof tools?.schemas === 'function',
    });
  }
  cache.at = Date.now();
  cache.value = value;
  return value;
}

/** Read the roster if the service is present; a missing roster is not an error. */
async function listPresets(ctx) {
  const service = ctx.get('agentPresets');
  if (service === undefined) return [];
  try {
    const all = await service.list();
    return (all ?? [])
      .map((entry) => ({
        id: entry?.id ?? entry?.definition?.id ?? null,
        name: entry?.name ?? entry?.definition?.name ?? entry?.id ?? null,
        order: entry?.order ?? entry?.definition?.order ?? null,
      }))
      .filter((entry) => typeof entry.id === 'string' && ['band', 'continuity', 'standard'].includes(entry.id))
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
  } catch {
    return [];
  }
}

/**
 * Project the shipped compaction-basic policy for one route. This is the
 * arithmetic the config-only experiment turns on; the live request header may
 * reserve fewer completion tokens than the adapter default, which lowers the
 * threshold fraction but never the retention below its ratio.
 */
async function projectWindow(ctx, config, cache, policy) {
  const key = `${config.provider}/${config.model}`;
  if (cache.key === key && Date.now() - cache.at < 60_000) return cache.value;

  let value;
  const llm = ctx.get('llm');
  try {
    if (llm === undefined) throw new Error('llm service unavailable');
    const info = await llm.resolveModelInfo(config.provider, config.model);
    const contextWindow = Number.isInteger(info?.context?.contextWindow)
      ? info.context.contextWindow
      : FALLBACK_WINDOW.contextWindow;
    const reservedTokens = Number.isInteger(info?.defaultMaxTokens)
      ? info.defaultMaxTokens
      : FALLBACK_WINDOW.defaultMaxTokens;
    value = project(contextWindow, reservedTokens, policy);
    value.source = 'ctx.llm.resolveModelInfo';
  } catch (error) {
    value = project(FALLBACK_WINDOW.contextWindow, FALLBACK_WINDOW.defaultMaxTokens, policy);
    value.source = `adapter defaults (${error?.message ?? error})`;
  }
  value.provider = config.provider;
  value.model = config.model;
  cache.key = key;
  cache.at = Date.now();
  cache.value = value;
  return value;
}

function project(contextWindow, reservedTokens, policy) {
  const messageBudget = contextWindow - reservedTokens;
  const baseThreshold = Math.floor(Math.min(contextWindow * 0.92, messageBudget - HEADROOM_TOKENS));
  const baseRetain = Math.floor(messageBudget * 0.5);
  return {
    available: true,
    contextWindow,
    reservedTokens,
    messageBudget,
    headroomTokens: HEADROOM_TOKENS,
    baseThresholdRatio: 0.92,
    baseRetainRatio: 0.5,
    baseThresholdTokens: baseThreshold,
    baseRetainTokens: baseRetain,
    basePassTokens: Math.max(0, baseThreshold - baseRetain),
    baseValid: baseRetain < baseThreshold,
    bandSetpointTokens: Math.floor(messageBudget * policy.setpoint),
    bandProtectTokens: Math.floor(messageBudget * policy.protect),
  };
}
