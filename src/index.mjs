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
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_POLICY } from './policy.mjs';
import { SYSTEM_CONVENTION, gistHeader } from './provenance.mjs';
import { continuityState } from './state.mjs';
import { buildFacetState } from './facets/panel-state.mjs';
import { PEER_PATH, handlePeerRequest, peerAgents } from './peer.mjs';
import { migrateThreadsFile } from './threads-store.mjs';
import { installExtractionPreStep, recordExtractionInstallError } from './memory/extraction-pre-step.mjs';
import { installBCPreStep } from './memory/bc-pre-step.mjs';
import { buildBCPanelState } from './memory/bc-panel-state.mjs';
import { isPersonaEnabled, resolvePersona, sessionFile } from './memory/persona.mjs';
import { installSessionGuard } from './session-guard.mjs';

export const name = 'dsh-continuity';
export const inject = [];

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
  try { installSessionGuard(ctx); } catch (error) {
    try { log.warn?.(`dsh-continuity: session guard not installed: ${error?.message ?? error}`); } catch { /* ignore */ }
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
  // Target-addressed peer delivery. An explicit `to` session id is required.
  try {
    ctx.on('agent/created', (payload = {}) => {
      const agent = payload?.agent;
      peerAgents.add(agent?.session?.id, agent);
    });
    ctx.on('session/disposed', (session = {}) => {
      peerAgents.remove(session?.id);
    });
  } catch (error) {
    try {
      appendFileSync(join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity', 'gate-errors.jsonl'), JSON.stringify({
        at: new Date().toISOString(), name: error?.name ?? 'Error', code: 'peer-registry-failed',
        message: String(error?.message ?? error),
      }) + '\n', 'utf8');
    } catch { /* registry failure is reported by the route's 404s */ }
  }
  const peerRoute = {
    kind: 'exact',
    path: PEER_PATH,
    handler: (req, res) => handlePeerRequest(req, res, { agents: peerAgents, log }),
  };
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(() => scoped.webServer.register(peerRoute));
    scoped.logger?.info?.(`[dsh-continuity] peer route mounted at ${PEER_PATH}`);
  });
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
  // 回合闸注册在这里，不在 engine 里：engine 是挂在 agent preset 里的 compaction service，
  // 它自己的 ctx 接不到 agent/* 事件（2026-10-30 实测：重启后 turn-stopping 一次都没触发，
  // 也没有注册错误——引擎那边是可选链，ctx 不对就静默跳过）。插件入口的 ctx 一定在。
  const hookHome = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity');
  if (config.safeMode === true) {
    log.info?.('[dsh-continuity] safe mode: turn-stopping hook not registered');
  } else try {
    ctx.on('agent/turn-stopping', (payload) => {
      // Dispatch probe: write this before the gate call so a null/foreign
      // engine is distinguishable from "the Host never dispatched".
      const turn = Number.isInteger(payload?.turn) ? payload.turn : null;
      const engine = continuityState.engineInstance;
      const engineCallable = typeof engine?.onTurnStopping === 'function';
      const agentSession = typeof payload?.agent?.session?.id === 'string' ? payload.agent.session.id : null;
      const continuitySession = continuityState.engineSession ?? null;
      const foreignSession = Boolean(agentSession && continuitySession && agentSession !== continuitySession);
      try {
        appendFileSync(join(hookHome, 'dispatch-probe.jsonl'),
          JSON.stringify({
            at: new Date().toISOString(),
            event: 'agent/turn-stopping',
            turn,
            enginePresent: Boolean(engine),
            engineCallable,
            agentSession,
            continuitySession,
            foreignSession,
          }) + '\n', 'utf8');
      } catch { /* probe failure must not block the gate */ }
      if (engineCallable) {
        void engine.onTurnStopping(payload);
      }
    });
    try {
      writeFileSync(join(hookHome, 'hook-registered.json'),
        JSON.stringify({ at: new Date().toISOString(), via: 'index.apply', event: 'agent/turn-stopping' }, null, 2), 'utf8');
    } catch { /* 探针写不进不影响注册 */ }
  } catch (error) {
    try {
      appendFileSync(join(hookHome, 'gate-errors.jsonl'), JSON.stringify({
        at: new Date().toISOString(), name: error?.name ?? 'Error', code: 'hook-register-failed',
        message: String(error?.message ?? error),
      }) + '\n', 'utf8');
    } catch { /* 只能放弃 */ }
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
    scoped.effect(() => scoped.webServer.register(bcRoute));
    scoped.effect(() => scoped.webServer.register(facetsRoute));
    scoped.effect(() => scoped.webServer.register(switchRoute));
    scoped.logger?.info?.(`[dsh-continuity] control panel mounted at ${path} (bc: ${bcPath}, facets: ${facetsPath})`);
  });
}

async function buildSnapshot(ctx, path, projectionConfig, cache, scopeCache, queryCache) {
  const engine = continuityState.engine;
  const policy = engine?.policy ?? DEFAULT_POLICY;
  const presets = await listPresets(ctx);
  const projection = await projectWindow(ctx, projectionConfig, cache, policy);
  const scopes = await inspectScopes(ctx, scopeCache);
  const sessionQuery = await probeSessionQuery(ctx, queryCache);

  return {
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
    const toolNames = tools?.schemas?.(agent)?.map((tool) => tool.name) ?? [];
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
