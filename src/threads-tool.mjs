import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { continuityHome } from './threads-store.mjs';
/**
 * `continuity` — model-facing thread scaffold for the Continuity preset.
 *
 * One tool with four actions (`save`, `load`, `active`, `list`) rather than dot
 * names: provider function-name grammars reject dots. The four actions are the
 * contract's `continuity.save` / `.load` / `.active` / `.list`.
 */
import { getThreadsBackend } from './threads-backend.mjs';
import { makeApi, ThreadsCore } from './threads-core.mjs';
import { markThreadsTool } from './state.mjs';
import { loadFacetQuery } from './facets/load.mjs';
import { createPeerTool } from './peer-tool.mjs';
import { createRecallTool } from './recall-tool.mjs';

export const name = 'dsh-continuity/threads-tool';
export const inject = ['tools', 'sessionQuery', 'tokenMeter'];

const DESCRIPTION = [
  'Explicit work threads for this Continuity session.',
  'save folds a completed surface range into a retrievable [thread] gist and records why/next/span/tokens.',
  'With threadId it appends that range as a new segment of the existing thread and makes it active;',
  'without threadId it creates a new thread and clears the active pointer. next is required: it is the',
  'first action on returning. An unknown threadId is rejected before anything is written.',
  'load appends the newest raw segment of one thread (default 8000 tokens, max 20000), sets it active,',
  'and says "now on this thread"; active/list inspect the index and segment count.',
  'scan returns a cheap event index for fromSeq..toSeq or seqs:[...] without injecting;',
  'reasoning is excluded by default and synthetic runtime-context/checkpoint messages are skipped.',
  'find returns the seqs of a tag id (T2, a thread id, or T0) from tags.json with no text;',
  'tag({seqs,id}) writes exact overrides, retag({from,to}) moves a whole tag, tags() lists them.',
  'load also accepts seqs:[...] (exact), or a tag id (earliest 3 + latest 5, budget-trimmed);',
  'thread ids keep the old latest-segment/range/select behavior. It returns segs listing what was',
  'actually injected; its quote excludes reasoning by default.',
  'save rejects any range that cuts a tool call/result pair and never folds the current open turn;',
  'the default range is capped at 200 message-producing nodes, keeping the newest ones.',
  'save and load return pending:true; the durable gist or quoted segment is appended at the next pre-step,',
  'after this tool result, so the current call/result pair is never split.',
  'Use save when you deliberately put a piece of work down; load when you deliberately pick it up.',
  'The user maintains the usage rules separately in ~/.dsh/continuity/rules.md; this tool only provides the mechanics.',
].join(' ');

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['save', 'switch', 'load', 'scan', 'find', 'tag', 'untag', 'retag', 'delete', 'tags', 'active', 'list'],
      description: 'save = close a range into a thread; load = reopen a thread/tag/seqs/query; scan = cheap event index; find = tag seqs/ranges; tag = metadata, exact overrides, or one run; untag = range back to T0; retag = move a tag; delete = remove a thread with a backup; tags = tag index; active/list = threads.',
    },
    query: {
      type: 'string',
      description: 'load: facet query or alias, e.g. "跑团". Resolves through facet-index.json to seqs; no T switch. Use instead of id/seqs.',
    },
    label: {
      type: 'string',
      description: 'save: one-line title, e.g. "T1 爬塔". For an append, the existing thread title is kept unless relabel:true. tag: optional display label for the tag.',
    },
    relabel: {
      type: 'boolean',
      description: 'save: explicit permission to change an existing thread label; default false keeps it.',
    },
    backfill: {
      type: 'boolean',
      description: 'save: historical archival segment from raw session events. Requires fromSeq/toSeq; appends to an existing thread and never touches the live surface.',
    },
    alias: {
      type: 'string',
      description: 'save/tag: optional short symbol, e.g. "T3". save sets the thread alias; tag sets the tag/thread alias. Auto-tagging and tags() display prefer it.',
    },
    keywords: {
      type: 'array',
      items: { type: 'string' },
      description: 'tag: optional keywords shown in tags.md.',
    },
    threadId: {
      type: 'string',
      description: 'save: optional existing thread id. Appends the range as a new segment and makes that thread active; unknown ids are rejected. Omit to create a new thread.',
    },
    why: {
      type: 'string',
      description: 'save: why this is being put down; future-you reads this on return.',
    },
    next: {
      type: 'string',
      description: 'save: REQUIRED first action when loading this thread back. Start with a verb.',
    },
    residue: {
      type: 'string',
      description: 'save: optional small deliberate remnant (≤1k tokens) to keep in the gist.',
    },
    fromSeq: {
      type: 'integer',
      description: 'save: optional inclusive start surface seq. load: optional start of the range to quote. scan: required start. tag/untag: inclusive start of a run.',
    },
    split: {
      type: 'boolean',
      description: 'save: when true and no fromSeq/toSeq, return a topic-split PLAN (no save happens). pending has one slot, so execute the plan one segment per step with explicit fromSeq/toSeq/threadId.',
    },
    toSeq: {
      type: 'integer',
      description: 'save: optional inclusive end surface seq. load: optional end of the range to quote. scan: required end. tag/untag: inclusive end of a run.',
    },
    id: {
      type: 'string',
      description: 'load/find/tag/delete: thread id, tag id (T2), or T0. For load, a thread keeps old behavior; a tag uses first/last (default 3/5).',
    },
    first: {
      type: 'integer',
      description: 'load tag: oldest N events (default 3).',
    },
    last: {
      type: 'integer',
      description: 'load tag: newest N events (default 5).',
    },
    autoSave: {
      type: 'boolean',
      description: 'load: default true. When loading a different thread, save the current one first (switch = put down, then pick up).',
    },
    force: {
      type: 'boolean',
      description: 'delete: required to remove a thread that has segments/tokens; the backup is written first.',
    },
    budgetTokens: {
      type: 'integer',
      description: 'load: quoted raw budget for the default/latest or fromSeq/toSeq range (default 8000, max 20000). An explicit select is not tail-truncated.',
    },
    withReasoning: {
      type: 'boolean',
      description: 'load: include paired reasoning under one 16k body+reasoning budget; reasoning is separate and truncated above 800 tokens. Default false (0.4.5 behavior).',
    },
    select: {
      type: 'array',
      items: { type: 'integer' },
      description: 'load (thread only): exact seqs to inject, usually from scan. Only visible non-reasoning text is quoted; the returned segs lists what was actually injected.',
    },
    seqs: {
      type: 'array',
      items: { type: 'integer' },
      description: 'scan/load/tag: exact seqs. scan may use seqs instead of fromSeq/toSeq; load injects exactly these; tag writes exact overrides. tag also accepts fromSeq/toSeq instead, as one run.',
    },
    after: {
      type: 'integer',
      description: 'find: strict lower bound (seq > after).',
    },
    before: {
      type: 'integer',
      description: 'find: strict upper bound (seq < before).',
    },
    from: {
      type: 'string',
      description: 'retag: old tag id.',
    },
    to: {
      type: 'string',
      description: 'retag: new tag id.',
    },
    headChars: {
      type: 'integer',
      description: 'scan: head length (default 160, max 200).',
    },
    includeReasoning: {
      type: 'boolean',
      description: 'scan: include reasoning blocks (default false).',
    },
    types: {
      type: 'array',
      items: { type: 'string' },
      description: 'scan: optional category/event-type/role filter, e.g. ["message"], ["tool-result"], ["user/message"]. Default ["message"].',
    },
    limit: {
      type: 'integer',
      description: 'scan: maximum items (default 20, max 100); the payload also stays under ~900 estimated tokens.',
    },
  },
  required: ['action'],
  allOf: [
    {
      if: { properties: { action: { const: 'load' } }, required: ['action'] },
      then: { anyOf: [{ required: ['id'] }, { required: ['seqs'] }, { required: ['query'] }] },
    },
    {
      if: { properties: { action: { const: 'scan' } }, required: ['action'] },
      then: {
        anyOf: [
          { required: ['fromSeq', 'toSeq'] },
          { required: ['seqs'] },
        ],
      },
    },
    {
      if: { properties: { action: { const: 'find' } }, required: ['action'] },
      then: { required: ['id'] },
    },
    {
      if: { properties: { action: { const: 'tag' } }, required: ['action'] },
      then: {
        required: ['id'],
        anyOf: [
          { required: ['seqs'] },
          { required: ['fromSeq', 'toSeq'] },
          { required: ['label'] },
          { required: ['keywords'] },
          { required: ['alias'] },
        ],
      },
    },
    {
      if: { properties: { action: { const: 'untag' } }, required: ['action'] },
      then: { required: ['fromSeq', 'toSeq'] },
    },
    {
      if: { properties: { action: { const: 'retag' } }, required: ['action'] },
      then: { required: ['from', 'to'] },
    },
    {
      if: { properties: { action: { const: 'delete' } }, required: ['action'] },
      then: { required: ['id'] },
    },
  ],
};

function assertAction(input) {
  if (input === null || typeof input !== 'object') throw new Error('continuity: arguments must be an object');
  const actions = ['save', 'switch', 'load', 'scan', 'find', 'tag', 'untag', 'retag', 'delete', 'tags', 'active', 'list'];
  if (!actions.includes(input.action)) {
    throw new Error(`continuity: action must be ${actions.join(', ')}`);
  }
  if (input.action === 'switch') {
    const hasId = typeof input.id === 'string' && input.id.trim().length > 0;
    const hasLabel = typeof input.label === 'string' && input.label.trim().length > 0;
    if (!hasId && !hasLabel) throw new Error('continuity.switch: id or label is required');
  }
  if (input.action === 'save') {
    if (input.backfill !== true) {
      for (const key of ['label', 'why', 'next']) {
        if (typeof input[key] !== 'string' || input[key].trim().length === 0) {
          throw new Error(`continuity.save: ${key} is required and must be a non-empty string`);
        }
      }
    }
    if (input.backfill !== undefined && typeof input.backfill !== 'boolean') {
      throw new Error('continuity.save: backfill must be boolean');
    }
    if (input.threadId !== undefined
      && (typeof input.threadId !== 'string' || input.threadId.trim().length === 0)) {
      throw new Error('continuity.save: threadId must be a non-empty string when provided');
    }
    if (input.alias !== undefined && (typeof input.alias !== 'string' || input.alias.trim().length === 0)) {
      throw new Error('continuity.save: alias must be a non-empty string when provided');
    }
    if (input.relabel !== undefined && typeof input.relabel !== 'boolean') {
      throw new Error('continuity.save: relabel must be boolean');
    }
  }
  if (input.action === 'load') {
    const hasId = typeof input.id === 'string' && input.id.trim().length > 0;
    const hasSeqs = Array.isArray(input.seqs) && input.seqs.length > 0;
    const hasQuery = typeof input.query === 'string' && input.query.trim().length > 0;
    if (!hasId && !hasSeqs && !hasQuery) throw new Error('continuity.load: id, seqs, or query is required');
    const hasFrom = input.fromSeq !== undefined && input.fromSeq !== null;
    const hasTo = input.toSeq !== undefined && input.toSeq !== null;
    if (hasFrom !== hasTo) throw new Error('continuity.load: pass both fromSeq and toSeq, or neither');
    if (hasQuery && (hasId || hasSeqs || hasFrom || input.select !== undefined)) {
      throw new Error('continuity.load: query is exclusive; do not combine it with id/seqs/fromSeq/select');
    }
    if (input.select !== undefined
      && (!Array.isArray(input.select) || input.select.length === 0
        || input.select.some((seq) => !Number.isInteger(Number(seq))))) {
      throw new Error('continuity.load: select must be a non-empty array of integer seqs');
    }
    if (hasSeqs && (hasFrom || input.select !== undefined)) {
      throw new Error('continuity.load: use seqs or fromSeq/toSeq/select, not both');
    }
    if (input.withReasoning !== undefined && typeof input.withReasoning !== 'boolean') {
      throw new Error('continuity.load: withReasoning must be boolean');
    }
    if (input.first !== undefined && (!Number.isInteger(Number(input.first)) || Number(input.first) < 0)) {
      throw new Error('continuity.load: first must be an integer >= 0');
    }
    if (input.last !== undefined && (!Number.isInteger(Number(input.last)) || Number(input.last) < 0)) {
      throw new Error('continuity.load: last must be an integer >= 0');
    }
    if (input.first !== undefined && input.last !== undefined
      && Number(input.first) === 0 && Number(input.last) === 0) {
      throw new Error('continuity.load: first and last cannot both be 0');
    }
    if ((input.first !== undefined || input.last !== undefined)
      && (hasSeqs || hasFrom || input.select !== undefined)) {
      throw new Error('continuity.load: first/last are only valid for a tag id');
    }
  }
  if (input.action === 'scan') {
    const hasSeqs = Array.isArray(input.seqs) && input.seqs.length > 0;
    const hasFrom = Number.isInteger(Number(input.fromSeq));
    const hasTo = Number.isInteger(Number(input.toSeq));
    if (!hasSeqs && (!hasFrom || !hasTo)) {
      throw new Error('continuity.scan: pass seqs, or both fromSeq and toSeq');
    }
    if (hasFrom && hasTo && Number(input.fromSeq) > Number(input.toSeq)) {
      throw new Error('continuity.scan: fromSeq must be <= toSeq');
    }
    if (input.types !== undefined
      && (!Array.isArray(input.types) || input.types.some((entry) => typeof entry !== 'string'))) {
      throw new Error('continuity.scan: types must be an array of strings');
    }
  }
  if (input.action === 'find' && (typeof input.id !== 'string' || input.id.trim().length === 0)) {
    throw new Error('continuity.find: id is required');
  }
  if (input.action === 'tag') {
    if (typeof input.id !== 'string' || input.id.trim().length === 0) throw new Error('continuity.tag: id is required');
    const hasSeqs = Array.isArray(input.seqs) && input.seqs.length > 0;
    const hasRange = input.fromSeq !== undefined || input.toSeq !== undefined;
    const hasMetadata = input.label !== undefined || input.keywords !== undefined || input.alias !== undefined;
    if (hasSeqs && hasRange) throw new Error('continuity.tag: use seqs or fromSeq/toSeq, not both');
    if (!hasSeqs && !hasRange && !hasMetadata) {
      throw new Error('continuity.tag: seqs, fromSeq/toSeq, or a metadata field is required');
    }
    if (hasSeqs && input.seqs.some((seq) => !Number.isInteger(Number(seq)))) {
      throw new Error('continuity.tag: seqs must be an array of integer seqs');
    }
    if (hasRange) {
      if (!Number.isInteger(Number(input.fromSeq)) || !Number.isInteger(Number(input.toSeq))) {
        throw new Error('continuity.tag: fromSeq and toSeq must both be integers');
      }
      if (Number(input.fromSeq) > Number(input.toSeq)) {
        throw new Error('continuity.tag: fromSeq must be <= toSeq');
      }
    }
    if (input.label !== undefined && (typeof input.label !== 'string' || input.label.trim().length === 0)) {
      throw new Error('continuity.tag: label must be a non-empty string when provided');
    }
    if (input.alias !== undefined && (typeof input.alias !== 'string' || input.alias.trim().length === 0)) {
      throw new Error('continuity.tag: alias must be a non-empty string when provided');
    }
    if (input.keywords !== undefined
      && (!Array.isArray(input.keywords) || input.keywords.some((entry) => typeof entry !== 'string'))) {
      throw new Error('continuity.tag: keywords must be an array of strings');
    }
  }
  if (input.action === 'untag') {
    if (!Number.isInteger(Number(input.fromSeq)) || !Number.isInteger(Number(input.toSeq))) {
      throw new Error('continuity.untag: fromSeq and toSeq must both be integers');
    }
    if (Number(input.fromSeq) > Number(input.toSeq)) {
      throw new Error('continuity.untag: fromSeq must be <= toSeq');
    }
  }
  if (input.action === 'retag') {
    for (const key of ['from', 'to']) {
      if (typeof input[key] !== 'string' || input[key].trim().length === 0) {
        throw new Error(`continuity.retag: ${key} is required`);
      }
    }
  }
  if (input.action === 'delete') {
    if (typeof input.id !== 'string' || input.id.trim().length === 0) {
      throw new Error('continuity.delete: id is required');
    }
    if (input.force !== undefined && typeof input.force !== 'boolean') {
      throw new Error('continuity.delete: force must be boolean');
    }
  }
}

/**
 * Build the tool. Exported for tests with a fake session/agent.
 * @param {{ sessionQuery: object, tokenMeter?: object, getBackend?: Function }} deps
 */

/**
 * 切换线头 = 先放下、再拿起。
 * load 一个不同的 thread 之前，自动把当前线头收成一段（save），
 * 它的 gist 会在下一个 pre-step 提交，从而折叠掉旧区间。
 * 失败不阻塞 load —— 拿不起新线比放下失败更糟。
 */

/** 在 load 之后留一个“接手”标记：下一轮注入三问（刚醒来的人视角）。 */
function markHandoff(kind, threadId) {
  try {
    const dir = (typeof process.env.USERPROFILE === "string" && process.env.USERPROFILE.length > 0)
      ? process.env.USERPROFILE + "/.dsh/continuity"
      : (process.env.HOME ?? "") + "/.dsh/continuity";
    writeFileSync(dir + "/handoff-pending.json", JSON.stringify({
      at: Date.now(),
      pid: process.pid,
      kind,
      threadId: threadId ?? null,
    }), "utf8");
  } catch { /* 记不下不影响 load */ }
}

/**
 * 切换前收起：**唯一的收起路径**。直接调 save，不另写一套折叠逻辑。
 *   - 切到别的线：exclude=目标 → 只折「不属于目标」的块；目标自己的轮原样留着
 *   - 同线 / 没给目标：threadId=当前线 → 折当前线自己的块
 */
async function forceSaveCurrent(core, input) {
  const active = await core.active();
  if (!active || typeof active.id !== 'string' || active.id.length === 0) return;
  const target = typeof input.id === 'string' && input.id.length > 0 ? input.id : null;
  const sameLine = target !== null && target === active.id;
  await core.save({
    label: active.label ?? active.id,
    why: typeof input.why === 'string' && input.why.length > 0 ? input.why : '切换线头：先收起再切换',
    next: typeof input.next === 'string' && input.next.length > 0
      ? input.next
      : (typeof active.next === 'string' && active.next.length > 0 ? active.next : '（未写）'),
    ...(sameLine || target === null ? { threadId: active.id } : { exclude: target }),
    ...(typeof input.residue === 'string' && input.residue.length > 0 ? { residue: input.residue } : {}),
  });
}

export function createThreadsTool({ sessionQuery, tokenMeter, getBackend = getThreadsBackend }) {
  if (sessionQuery === undefined || sessionQuery === null) throw new Error('continuity: sessionQuery is required');
  return {
    name: 'continuity',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {};
      assertAction(input);
      exec?.signal?.throwIfAborted?.();
      // 欠账**不再锁工具**（历史调试 用户裁定：挡 save 只会让实例最后存不下、消失；
      // 挡读只会让人恼怒）。真正的闸在回合末：'agent/turn-stopping' 里催补标并把本轮续上。
      // tag-debt.json 仍由引擎写，只作为头部提示的来源，工具层不再据此拒绝。
      const backend = {
        prepareSave: (agent, saveArgs) => getBackend().prepareSave(agent, saveArgs),
      };
      const core = new ThreadsCore({
        agent: exec?.agent,
        sessionQuery,
        tokenMeter,
        backend,
      });
      const api = makeApi(core);
      // 收起失败不再静默：记一行到 save-before-switch.log，并把错误挂到 load/switch 的回执上。
      let saveError = null;
      const logSaveFailure = (action) => (error) => {
        saveError = `${String(error?.name ?? 'Error')}: ${String(error?.message ?? error).slice(0, 300)}`;
        try {
          appendFileSync(join(continuityHome(), 'save-before-switch.log'), JSON.stringify({
            at: new Date().toISOString(),
            action,
            name: String(error?.name ?? 'Error'),
            message: String(error?.message ?? error).slice(0, 400),
          }) + '\n');
        } catch { /* 写不了日志也不能阻断 */ }
      };
      let result;
      if (input.action === 'switch') {
        try { await forceSaveCurrent(core, input); } catch (error) { logSaveFailure('switch')(error); }
        result = await api.load({ ...input, autoSave: false }, exec?.signal);
      }
      else if (input.action === 'save') { result = await api.save(input, exec?.signal); }
      else if (input.action === 'load') {
      // load 现在等同 switch：先收当前段（收起即折叠），再载入目标。
      let loadInput = input;
      let facetLoad = null;
      if (typeof input.query === 'string' && input.query.trim().length > 0) {
        facetLoad = loadFacetQuery(input.query, {
          indexFile: join(continuityHome(), 'facet-index.json'),
          topK: 50,
        });
        if (facetLoad.seqs.length === 0) {
          return JSON.stringify({
            ok: false,
            reason: 'facet-no-match',
            query: input.query,
            hint: 'run facet-scan or generate facet-index.json first',
          });
        }
        loadInput = { ...input, seqs: facetLoad.seqs, query: undefined };
      }
      if (loadInput.autoSave !== false) {
        try { await forceSaveCurrent(core, loadInput); } catch (error) { logSaveFailure('load')(error); }
      }
      result = await api.load(loadInput, exec?.signal);
      if (facetLoad !== null) result = { ...result, facetQuery: { query: input.query, ranges: facetLoad.ranges, seqs: facetLoad.seqs.length } };
      markHandoff('load', loadInput?.id ?? null);
    }
      else if (input.action === 'scan') result = await api.scan(input, exec?.signal);
      else if (input.action === 'find') result = await api.find(input);
      else if (input.action === 'tag') result = await api.tag(input);
      else if (input.action === 'untag') result = await api.untag(input);
      else if (input.action === 'retag') result = await api.retag(input);
      else if (input.action === 'delete') result = await api.delete(input);
      else if (input.action === 'tags') result = await api.tags();
      else if (input.action === 'active') result = await api.active();
      else result = await api.list();
      // 收起失败要看得见（以前只写日志或干脆吞掉，实测时表现为"什么都没折"）。
      if (saveError !== null) result = { ...result, autoSaveError: saveError };
      return JSON.stringify(result);
    },
  };
}

export function apply(ctx, config = {}) {
  if (config?.safeMode !== true) {
    const tool = createThreadsTool({ sessionQuery: ctx.sessionQuery, tokenMeter: ctx.tokenMeter });
    ctx.effect(() => {
      const dispose = ctx.tools.register(tool);
      markThreadsTool({ name: tool.name, scope: 'continuity preset' });
      return dispose;
    });
  } else {
    try { ctx.logger?.info?.('[dsh-continuity] safe mode: continuity/T tool not registered'); } catch { /* ignore */ }
  }
  const recallTool = createRecallTool({ sessionQuery: ctx.sessionQuery });
  ctx.effect(() => ctx.tools.register(recallTool));
  const peer = createPeerTool();
  ctx.effect(() => ctx.tools.register(peer));
}
