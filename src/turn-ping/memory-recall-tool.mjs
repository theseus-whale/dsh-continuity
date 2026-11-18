import { turnPingBeforeAnswer } from './registry.mjs';

const pick = (owner) => (typeof owner?.get === 'function' ? owner.get('sessionQuery') : owner?.sessionQuery);

export function createMemoryRecallTool({ beforeAnswer = turnPingBeforeAnswer, resolveSessionQuery } = {}) {
  const resolve = (exec) => (typeof resolveSessionQuery === 'function'
    ? resolveSessionQuery(exec)
    : pick(exec?.agent?.ctx) ?? pick(exec?.agent));
  return {
    name: 'memory_recall',
    description: 'Actively recall earlier conversation by meaning. Write what you want to remember in your own words; uses the same memory-resonance semantic retrieval as automatic memory_cue. Returns summaries and raw pointers, not exact-search matches. If you already have a seq coordinate, use read_seq_range instead.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'The memory, topic, decision, or event you want to recall.' },
      },
      required: ['query'],
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value ?? '') }] },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args = {}, exec = {}) {
      const query = String(args.query ?? '').trim();
      if (!query) throw new Error('memory_recall: query required');
      if (query.length > 4000) throw new Error('memory_recall: query exceeds 4000 chars');
      const sessionId = exec?.agent?.session?.id;
      if (!sessionId) throw new Error('memory_recall: no current session');
      const service = resolve(exec);
      if (!service || typeof service.readSession !== 'function') throw new Error('memory_recall: sessionQuery unavailable');
      const snapshot = await service.readSession(String(sessionId));
      const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
      const nodes = Array.isArray(snapshot?.surface?.nodes) ? snapshot.surface.nodes : [];
      const cutoff = Number(nodes.at(-1) ?? events.at(-1)?.seq);
      if (!Number.isInteger(cutoff)) return '[memory_recall] 没有可检索的历史边界。';
      const result = await beforeAnswer({ sessionId: String(sessionId), query, cutoff, events });
      if (!result?.enabled) return '[memory_recall] 当前会话未启用记忆共振。';
      if (!result.ping?.text || Number(result.H ?? 0) <= 0) return '[memory_recall] 没有回忆起可靠内容。';
      return result.ping.text;
    },
  };
}

export function apply(ctx) {
  const tool = createMemoryRecallTool({ resolveSessionQuery: (exec) => pick(exec?.agent?.ctx) ?? pick(ctx) });
  ctx.effect(() => ctx.tools.register(tool));
  return tool;
}

export const name = 'memory-recall-tool';
export const inject = ['tools'];
