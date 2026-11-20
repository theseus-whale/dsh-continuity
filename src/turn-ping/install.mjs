import path from 'node:path';
import { continuityHome } from '../folds-store.mjs';
import { createTurnPingHost } from './host.mjs';
import { setTurnPingHost } from './registry.mjs';
import { appendDiagnostic } from './diagnostics.mjs';
import { recordError } from '../state.mjs';

/** Persist and surface an installation failure without blocking the Host row. */
export function recordTurnPingInstallIssue({
  home = continuityHome(),
  config = {},
  code = 'turn-ping-install-failed',
  error = null,
  reason = null,
  log = null,
} = {}) {
  const message = String(error?.message ?? error ?? reason ?? 'unknown turn-ping installation failure');
  const entry = {
    kind: 'turn-ping-install',
    code,
    name: String(error?.name ?? 'Error'),
    message,
  };
  appendDiagnostic(path.join(home, 'gate-errors.jsonl'), entry);
  if (config?.diagnostics?.enabled === true) {
    const diagnosticPath = config.diagnostics?.path || path.join(home, 'turn-ping-prestep-debug.jsonl');
    appendDiagnostic(diagnosticPath, { ...entry, kind: 'install-error' });
  }
  recordError(message, code);
  try { log?.warn?.(`[dsh-continuity] ${code}: ${message}`); } catch { /* logging must not block the Host row */ }
  return entry;
}

/**
 * Install the turn-ping host core only when explicitly configured.
 * No provider/embedder means no host: default-off never fabricates one.
 */
export function installTurnPing({ config = {}, provider = null, embedder = null } = {}) {
  if (config?.enabled !== true) return { enabled: false, reason: 'disabled' };
  if (typeof provider !== 'function') return { enabled: false, reason: 'summary-provider-unavailable' };
  if (typeof embedder !== 'function') return { enabled: false, reason: 'embedder-unavailable' };
  const home = config.home || continuityHome();
  const host = createTurnPingHost({ config, home, provider, embedder });
  const diagnosticPath = config.diagnostics?.path || path.join(home, 'turn-ping-prestep-debug.jsonl');
  if (config.diagnostics?.enabled === true) {
    appendDiagnostic(diagnosticPath, { kind: 'install', home: path.resolve(home), indexVersion: host.indexVersion, enabled: true, mode: config.mode ?? null });
  }
  setTurnPingHost(host);
  return { enabled: true, host, home: path.resolve(home), indexVersion: host.indexVersion, diagnosticPath };
}
