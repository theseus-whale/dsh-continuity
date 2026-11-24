import { turnPingBeforeAnswer } from './registry.mjs';

const pick = (owner) => (typeof owner?.get === 'function' ? owner.get('sessionQuery') : owner?.sessionQuery);

export function createMemoryRecallTool({ beforeAnswer = turnPingBeforeAnswer, resolveSessionQuery } = {}) {
  const resolve = (exec) => (typeof resolveSessionQuery === 'function'
    ? resolveSessionQuery(exec)
    : pick(exec?.agent?.ctx) ?? pick(exec?.agent));
  return {
    name: 'memory_recall',
    description: 'Actively recall earlier conversation by meaning. Write what you want to remember in your own words; uses the same memory-resonance semantic retrieval as automatic memory_cue. Returns summaries and raw pointers, not exact-search matches. After finding a useful HIT, use memory_related with its turnId or seq to explore semantically similar chunks before or after that memory point; use chunkIndex or chunkId only to disambiguate split chunks. If you already have a seq coordinate, use read_seq_range to read exact raw text.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'The memory, topic, decision, or event you want to recall.' },
        cursor: { type: 'string', description: 'Optional full-library next-page cursor returned by the same query and index.' },
        beforeSeq: { type: 'integer', minimum: 1, description: 'Optional full-library upper bound; only summaries ending strictly before this seq are searched.' },
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
      const cursor = String(args.cursor ?? '').trim() || null;
      const beforeSeq = args.beforeSeq ?? null;
      const sessionId = exec?.agent?.session?.id;
      if (!sessionId) throw new Error('memory_recall: no current session');
      const service = resolve(exec);
      if (!service || typeof service.readSession !== 'function') throw new Error('memory_recall: sessionQuery unavailable');
      const snapshot = await service.readSession(String(sessionId));
      const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
      const nodes = Array.isArray(snapshot?.surface?.nodes) ? snapshot.surface.nodes : [];
      const cutoff = Number(nodes.at(-1) ?? events.at(-1)?.seq);
      if (!Number.isInteger(cutoff)) return '[memory_recall] 没有可检索的历史边界。';
      const result = await beforeAnswer({ sessionId: String(sessionId), query, cutoff, events, cursor, beforeSeq });
      if (!result?.enabled) return '[memory_recall] 当前会话未启用记忆共振。';
      const hasHits = Boolean(result.ping?.text) && Number(result.H ?? 0) > 0;
      if (!hasHits && !result.nextCursor) return '[memory_recall] 没有回忆起可靠内容。';
      const footer = [];
      const diagnostics = result.retrieval?.prototype;
      if (diagnostics) footer.push(`[memory_recall] 全库检索：本页候选 ${diagnostics.candidateCount}／全库 ${diagnostics.totalCount ?? diagnostics.candidateCount}，相关 ${diagnostics.relevantCount}，时间探索 ${diagnostics.explorationCount}。`);
      if (result.nextCursor) footer.push(`[memory_recall] 下一页 cursor：${result.nextCursor}`);
      return [hasHits ? result.ping.text : '[memory_recall] 本页没有可靠内容，可继续下一页。', ...footer].join('\n\n');
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
