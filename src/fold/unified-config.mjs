import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve the unified-fold feature from a public config plus an optional local
 * overlay file. The public package can therefore ship enabled=false without
 * any session ids; a user-local file enables chosen sessions without patching
 * nested engine rows.
 *
 * Semantics:
 * - no localConfig file: public config applies (normally disabled)
 * - localConfig file: whitelisted keys override the public config
 * - local overlay must specify a non-empty sessionIds array to enable
 * - [] explicitly denies all sessions; omitted ids in an overlay is an error
 * - a missing/malformed overlay fails closed (missing returns null, malformed throws)
 */
export function resolveUnifiedFoldConfig(config, { home = process.cwd() } = {}) {
  if (!config || typeof config !== 'object') return null;
  let merged = { ...config };
  if (typeof config.localConfig === 'string' && config.localConfig.length > 0) {
    const file = path.isAbsolute(config.localConfig) ? config.localConfig : path.resolve(home, config.localConfig);
    if (!fs.existsSync(file)) return null;
    const local = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!local || typeof local !== 'object' || Array.isArray(local)) throw new Error('unified-fold local config must be a JSON object');
    merged = { ...config, ...local, localConfig: config.localConfig };
  }
  if (merged.enabled !== true) return null;
  let ids = merged.sessionIds;
  if (ids === undefined || ids === null) {
    if (config.localConfig) throw new Error('unified-fold local overlay must specify sessionIds; omitted means all sessions and is refused');
    return { ...merged, sessionIds: null };
  }
  if (!Array.isArray(ids)) throw new Error('unified-fold sessionIds must be an array');
  ids = [...new Set(ids.map(String).filter((id) => id.length > 0))];
  if (ids.length === 0) return null;
  return { ...merged, sessionIds: new Set(ids) };
}
