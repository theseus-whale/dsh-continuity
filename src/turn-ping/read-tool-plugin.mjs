import { createReadSeqRangeTool } from './read-tool.mjs';

const pick = (owner) => (typeof owner?.get === 'function' ? owner.get('sessionQuery') : owner?.sessionQuery);

/** Explicit preset tool registration; no sessionQuery gate at registration. */
export function apply(ctx, config = {}) {
  const resolveSessionQuery = (exec) => pick(exec?.agent?.ctx) ?? pick(ctx);
  const tool = createReadSeqRangeTool({
    resolveSessionQuery,
    allowedSessionIds: Array.isArray(config?.allowedSessionIds) ? config.allowedSessionIds : null,
  });
  ctx.effect(() => ctx.tools.register(tool));
  return tool;
}

export const name = 'read-seq-range-tool';
export const inject = ['tools'];
