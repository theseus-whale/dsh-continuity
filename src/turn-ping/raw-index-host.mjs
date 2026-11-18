import { appendDiagnostic } from './diagnostics.mjs';

/**
 * Attach raw indexing to real host events. No provider, model, timer, or fold is
 * needed. Public defaults never call this; the caller supplies an opted-in config.
 */
export function installRawIndexHost({ ctx, config = {}, home, diagnosticPath, indexFor }) {
  if (config?.enabled !== true || config?.rawIndex?.enabled === false) return { wired: false, reason: 'disabled' };
  if (!ctx || typeof ctx.on !== 'function') return { wired: false, reason: 'no-host-events' };
  if (typeof indexFor !== 'function') throw new Error('raw index host: indexFor required');
  const allowed = Array.isArray(config.sessionIds) && config.sessionIds.length > 0
    ? new Set(config.sessionIds.map(String)) : null;
  const opened = new Set();
  const errors = [];

  const permit = (sessionId) => allowed === null || allowed.has(String(sessionId));
  const fail = (sessionId, error, stage) => {
    const row = {
      at: new Date().toISOString(), kind: 'raw-index-error', sessionId: String(sessionId ?? ''),
      stage, error: String(error?.message ?? error),
    };
    errors.push(row);
    try { appendDiagnostic(diagnosticPath, row); } catch { /* the in-memory error remains visible */ }
    return { indexed: false, error: row.error, stage };
  };
  const open = (session) => {
    const sessionId = String(session?.id ?? '');
    if (!sessionId || !permit(sessionId) || opened.has(sessionId)) return { reconciled: false };
    if (typeof session?.snapshotEvents !== 'function') return fail(sessionId, 'snapshotEvents unavailable', 'open');
    try {
      const result = indexFor(sessionId).reconcile(session.snapshotEvents());
      opened.add(sessionId);
      return result;
    } catch (error) { return fail(sessionId, error, 'open'); }
  };

  const disposers = [
    ctx.on('agent/created', (payload = {}) => open(payload?.agent?.session)),
    ctx.on('session/created', (session) => open(session)),
    ctx.on('agent/pre-step', (payload, next) => {
      const session = payload?.agent?.session;
      if (session?.id && !opened.has(String(session.id))) open(session);
      return next();
    }),
    ctx.on('session/event', (session, event) => {
      const sessionId = String(session?.id ?? '');
      if (!sessionId || !permit(sessionId)) return { indexed: false, reason: 'not-allowed' };
      try { return indexFor(sessionId).ingest(event); } catch (error) { return fail(sessionId, error, 'event'); }
    }),
  ].filter((entry) => typeof entry === 'function');

  return {
    wired: true,
    open,
    errors,
    dispose() { for (const dispose of disposers) dispose(); },
  };
}
