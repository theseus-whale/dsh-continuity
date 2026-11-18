import { installCanonicalReadRawChunkTool } from './read-raw-chunk-canonical.mjs';
import { continuityHome } from '../folds-store.mjs';

export const name = 'read-raw-chunk-tool';
export const inject = ['tools'];

export function apply(ctx, config = {}) {
  const result = installCanonicalReadRawChunkTool(ctx, {
    home: config.home ?? config.continuityHome ?? continuityHome(),
    continuityHome: config.continuityHome ?? (typeof ctx?.get === 'function' ? ctx.get('continuityHome') : undefined),
    allowedSessionIds: Array.isArray(config.allowedSessionIds) ? new Set(config.allowedSessionIds.map(String)) : null,
  });
  return result;
}
