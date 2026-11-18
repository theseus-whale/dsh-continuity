import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve the Host memory-resonance config from a public, disabled config plus
 * an unpublished local overlay. The overlay is deliberately separate from the
 * unified-fold overlay: one controls Host retrieval/injection, the other
 * controls fold migration.
 *
 * Public config normally: enabled=false, localConfig=./local/memory-resonance.json
 * Missing overlay -> public config (disabled).
 * Malformed overlay -> throw.
 * Enabled overlay requires a non-empty sessionIds allowlist.
 */
export function resolveTurnPingConfig(config = {}, { home = process.cwd() } = {}) {
  if (!config || typeof config !== 'object') return config;
  if (typeof config.localConfig !== 'string' || config.localConfig.length === 0) return config;
  const file = path.isAbsolute(config.localConfig) ? config.localConfig : path.resolve(home, config.localConfig);
  if (!fs.existsSync(file)) return config;
  const local = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!local || typeof local !== 'object' || Array.isArray(local)) throw new Error('turn-ping local config must be a JSON object');
  const merged = { ...config, ...local };
  if (merged.enabled === true) {
    if (!Array.isArray(merged.sessionIds) || merged.sessionIds.length === 0) {
      throw new Error('turn-ping local config: enabled=true requires a non-empty sessionIds allowlist');
    }
    merged.sessionIds = [...new Set(merged.sessionIds.map(String).filter((id) => id.length > 0))];
    if (merged.sessionIds.length === 0) throw new Error('turn-ping local config: empty sessionIds allowlist');
  }
  if (merged.mode !== undefined && merged.mode !== 'shadow' && merged.mode !== 'opt-in') {
    throw new Error('turn-ping local config: mode must be shadow or opt-in');
  }
  return merged;
}
