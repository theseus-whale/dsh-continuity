/**
 * `session_log` — read-only retrieval tool, scoped to the Continuity preset.
 *
 * It is a plain ToolDefinition (no `defineTool` import), so the linked
 * package needs no `@deepseek-ai/dsh-tools` resolution from the workspace.
 * Host data comes from `ctx.sessionQuery.readSession()`: live-preferred,
 * replay-validated, and read-only. Nothing here appends, replaces, or
 * compacts.
 */
import {
  buildIndex,
  buildStats,
  eventRole,
  eventText,
  getRange,
  grepRange,
  parsePointer,
  SessionLogError,
  tailSeqs,
} from './session-log.mjs';
import { readAssetIndex, assetMarker } from './assets.mjs';
import { createSessionAssetTool, createChildAssetTool } from './asset-tool.mjs';
import { createHandoffTool } from './handoff-tool.mjs';
import { join } from 'node:path';
import { continuityState, markSessionLogTool } from './state.mjs';

export const name = 'dsh-continuity/session-log-tool';
export const inject = ['tools', 'sessionQuery', 'tokenMeter'];

const DESCRIPTION = [
  'Read-only access to this machine\'s DSH session log.',
  'Use it when a [gist] block\'s header says the original is retrievable and the exact',
  'wording, date, number, promise, or name matters.',
  'index lists gist ranges for a session; get reads one seq or a start-end range',
  '(a gist header pointer is a range); grep finds literal text and returns seqs for get;',
  'stats reports surface token share by block (reasoning, tool result, assistant text,',
  'tool-call, user) and can report the full raw log with scope="raw".',
  'Pass a session id or a `log:<id>#seq=A-B` pointer; the current session is the default.',
  'Output is truncated with a manifest and a next seq; never dump a large range.',
  'Never writes, never changes the surface, never triggers compaction.',
  'If the original is unavailable, say you only remember the gist; stop after 2-3 fetches.',
].join(' ');

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['index', 'get', 'grep', 'stats'],
      description: 'index = list gist ranges; get = read seq or start-end; grep = literal text search; stats = per-block context share.',
    },
    scope: {
      type: 'string',
      enum: ['surface', 'raw'],
      description: 'stats: surface (default, current context via tokenMeter) or raw (whole historical log, chars/4 estimate).',
    },
    session: {
      type: 'string',
      description: 'Session id, or a gist pointer `log:<id>#seq=A-B`. Default: the current session.',
    },
    seq: {
      type: 'integer',
      description: 'get: one event seq.',
    },
    start: {
      type: 'integer',
      description: 'get: inclusive start event seq (pair with end; a gist pointer fills both).',
    },
    end: {
      type: 'integer',
      description: 'get: inclusive end event seq.',
    },
    query: {
      type: 'string',
      description: 'grep: literal, case-insensitive text. At least 2 characters.',
    },
    limit: {
      type: 'integer',
      description: 'Maximum gists/events/matches to return (default 20, max 100).',
    },
    context: {
      type: 'integer',
      description: 'get seq / grep match: neighboring events before and after (default 0, max 10).',
    },
  },
  required: ['action'],
};

/**
 * Format stats for the live surface or the raw historical log. Surface mode
 * uses the host token meter; raw mode is an explicit chars/4 estimate.
 */
async function statsText({ liveSession, sessionId, scope, sessionQuery, tokenMeter }) {
  const live = liveSession !== null && liveSession !== undefined
    && String(liveSession.id) === String(sessionId);
  if (scope === 'surface' && live) {
    const events = [];
    for (const seq of liveSession.surface?.nodes ?? []) {
      const event = liveSession.eventAt(seq);
      if (event !== undefined) events.push(event);
    }
    let measurement = null;
    try {
      measurement = tokenMeter?.measure?.(liveSession) ?? null;
    } catch {
      measurement = null;
    }
    const tokensBySeq = new Map();
    for (const node of measurement?.nodes ?? []) {
      if (node?.seq !== undefined) tokensBySeq.set(Number(node.seq), Number(node.tokens));
    }
    const stats = buildStats(events, { tokensBySeq });
    const surfaceTokens = Number.isFinite(measurement?.surfaceTokens)
      ? measurement.surfaceTokens
      : stats.totalTokens;
    const totalTokens = Number.isFinite(measurement?.totalTokens)
      ? measurement.totalTokens
      : surfaceTokens;
    const baseline = Math.max(0, totalTokens - surfaceTokens);
    const source = tokensBySeq.size > 0 ? 'tokenMeter' : 'chars4 estimate';

    const header = typeof liveSession.requestHeader === 'function' ? liveSession.requestHeader() : null;
    const tools = Array.isArray(header?.tools) ? header.tools : [];
    const toolSchemaChars = tools.length > 0 ? JSON.stringify(tools).length : 0;

    const lines = [
      `session_log stats · session=${sessionId} · scope=surface · source=${source}`,
      `events=${events.length} surfaceTokens=${Math.round(surfaceTokens)} baseline=${Math.round(baseline)} totalTokens=${Math.round(totalTokens)}`,
    ];
    const denom = stats.totalTokens > 0 ? stats.totalTokens : 1;
    for (const row of stats.rows) {
      if (row.chars <= 0) continue;
      const share = (100 * row.tokens / denom).toFixed(1);
      lines.push(`${row.category.padEnd(14)} count=${String(row.count).padEnd(5)} chars=${String(row.chars).padEnd(9)} tokens=${String(Math.round(row.tokens)).padEnd(8)} share=${share}%`);
    }
    if (tools.length > 0) {
      lines.push(`tools_schema   count=${String(tools.length).padEnd(5)} chars=${String(toolSchemaChars).padEnd(9)} ~tokens=${Math.ceil(toolSchemaChars / 4)} (baseline)`);
    }

    const policy = continuityState.engine?.policy;
    const context = continuityState.context;
    const windowTokens = context?.sessionId === String(sessionId) ? context.windowTokens : null;
    const protect = Number.isFinite(policy?.protect) ? policy.protect : null;
    const tailBudget = Number.isFinite(windowTokens) && protect !== null
      ? Math.round(windowTokens * protect)
      : null;
    if (tailBudget !== null && tokensBySeq.size > 0) {
      const tail = tailSeqs(liveSession.surface.nodes, tokensBySeq, tailBudget);
      const tailEvents = events.filter((event) => tail.has(event.seq));
      const tailStats = buildStats(tailEvents, { tokensBySeq });
      const tailDenom = tailStats.totalTokens > 0 ? tailStats.totalTokens : 1;
      lines.push(`tail · protect=${(protect * 100).toFixed(0)}% × W=${windowTokens} = ${tailBudget} tokens · events=${tailEvents.length}`);
      for (const row of tailStats.rows) {
        if (row.chars <= 0) continue;
        const share = (100 * row.tokens / tailDenom).toFixed(1);
        lines.push(`  ${row.category.padEnd(12)} tokens=${String(Math.round(row.tokens)).padEnd(8)} share=${share}%`);
      }
    }
    return lines.join('\n');
  }

  let snapshot;
  try {
    snapshot = await sessionQuery.readSession(sessionId);
  } catch (error) {
    throw new Error(
      `session_log: cannot read session ${sessionId}: ${error?.message ?? error}. `
      + 'The original may be unavailable; if so, say you only remember the gist.',
    );
  }
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const stats = buildStats(events);
  const note = scope === 'surface'
    ? 'surface unavailable; raw fallback; historical; may overlap summaries; not context'
    : 'historical; may overlap summaries; not context';
  const lines = [
    `session_log stats · session=${sessionId} · scope=raw · source=chars4 estimate (${note})`,
    `events=${events.length} chars=${stats.totalChars} ~tokens=${Math.ceil(stats.totalChars / 4)}`,
  ];
  const denom = stats.totalTokens > 0 ? stats.totalTokens : 1;
  for (const row of stats.rows) {
    if (row.chars <= 0) continue;
    const share = (100 * row.tokens / denom).toFixed(1);
    lines.push(`${row.category.padEnd(14)} count=${String(row.count).padEnd(5)} chars=${String(row.chars).padEnd(9)} ~tokens=${String(Math.ceil(row.tokens)).padEnd(8)} share=${share}%`);
  }
  return lines.join('\n');
}

/**
 * Build the tool definition. Exported for tests with a fake `sessionQuery`.
 * @param {{ sessionQuery: { readSession(sessionId: unknown): Promise<{ events?: unknown[] }> }, tokenMeter?: object }} deps
 */
export function createSessionLogTool({ sessionQuery, tokenMeter }) {
  if (sessionQuery === undefined || sessionQuery === null) {
    throw new Error('session_log: sessionQuery service is required');
  }
  return {
    name: 'session_log',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {};
      const action = input.action;
      if (action !== 'index' && action !== 'get' && action !== 'grep' && action !== 'stats') {
        throw new Error('session_log: action must be "index", "get", "grep", or "stats".');
      }
      exec?.signal?.throwIfAborted?.();

      const pointer = input.session === undefined || input.session === null
        ? { sessionId: null, start: null, end: null }
        : parsePointer(input.session);
      const sessionId = pointer.sessionId ?? exec?.agent?.id ?? null;
      if (sessionId === null) {
        throw new Error('session_log: no session id. Pass session=<id or gist pointer>, or run from an agent.');
      }

      if (action === 'stats') {
        try {
          return await statsText({
            liveSession: exec?.agent?.session ?? null,
            sessionId,
            scope: input.scope === 'raw' ? 'raw' : 'surface',
            sessionQuery,
            tokenMeter,
          });
        } catch (error) {
          if (error instanceof SessionLogError) {
            throw new Error(`session_log stats: ${error.message}`);
          }
          throw error;
        }
      }

      let snapshot;
      try {
        snapshot = await sessionQuery.readSession(sessionId);
      } catch (error) {
        throw new Error(
          `session_log: cannot read session ${sessionId}: ${error?.message ?? error}. `
          + 'The original may be unavailable; if so, say you only remember the gist.',
        );
      }
      exec?.signal?.throwIfAborted?.();
      const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
      const start = input.start ?? pointer.start ?? undefined;
      const end = input.end ?? pointer.end ?? undefined;

      try {
        if (action === 'index') {
          const text = buildIndex({ sessionId, events, limit: input.limit }).text;
          let childRows = [];
          try {
            const home = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity');
            childRows = (await readAssetIndex({ home, sessionId }))
              .filter((row) => row.owner === 'child')
              .slice(-20)
              .reverse();
          } catch { /* child assets are optional */ }
          return childRows.length === 0
            ? text
            : [text, 'child assets (use child_asset):', ...childRows.map((row) => assetMarker(row, 'child'))].join('\n');
        }
        if (action === 'get') {
          let assets = [];
          try {
            const home = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity');
            assets = (await readAssetIndex({ home, sessionId }))
              .filter((row) => row.owner === 'parent');
          } catch { /* markers are optional */ }
          return getRange({
            sessionId,
            events,
            seq: input.seq,
            start,
            end,
            context: input.context,
            limit: input.limit,
            assets,
          }).text;
        }
        return grepRange({
          sessionId,
          events,
          query: input.query,
          context: input.context,
          limit: input.limit,
        }).text;
      } catch (error) {
        if (error instanceof SessionLogError) {
          throw new Error(`session_log ${action}: ${error.message}`);
        }
        throw error;
      }
    },
  };
}

/**
 * Preset-scoped plugin entry. The row lives inside the `continuity` preset, so
 * `standard` never sees the tool.
 */
export function apply(ctx) {
  const tool = createSessionLogTool({ sessionQuery: ctx.sessionQuery, tokenMeter: ctx.tokenMeter });
  ctx.effect(() => {
    const dispose = ctx.tools.register(tool);
    markSessionLogTool({ name: tool.name, scope: 'continuity preset' });
    return dispose;
  });
  const assetTool = createSessionAssetTool();
  ctx.effect(() => ctx.tools.register(assetTool));
  const childAssetTool = createChildAssetTool({ sessionQuery: ctx.sessionQuery });
  ctx.effect(() => ctx.tools.register(childAssetTool));
  const handoffTool = createHandoffTool();
  ctx.effect(() => ctx.tools.register(handoffTool));
}
