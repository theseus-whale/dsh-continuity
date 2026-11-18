import { createReadSeqRangeTool } from './read-tool.mjs';

/** Resolve the query service from the execution-time agent scope first. */
export function installReadSeqRangeTool(ctx, { allowedSessionIds = null } = {}) {
  if (!ctx || typeof ctx.inject !== 'function') throw new Error('read_seq_range install: ctx.inject required');
  let registered = null;
  ctx.inject(['tools'], (scoped) => {
    const pick = (owner) => (typeof owner?.get === 'function' ? owner.get('sessionQuery') : owner?.sessionQuery);
    const resolveSessionQuery = (exec) => pick(exec?.agent?.ctx) ?? pick(scoped) ?? pick(ctx);
    const tool = createReadSeqRangeTool({ resolveSessionQuery, allowedSessionIds });
    registered = tool;
    scoped.effect?.(() => scoped.tools.register(tool));
    return tool;
  });
  return { registered, requires: ['tools'], resolver: 'exec.agent.ctx.get(sessionQuery) -> scoped -> root' };
}
