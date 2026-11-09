/**
 * recall_exact — read-only literal search inside the current Continuity session.
 *
 * Merged from the former `@local/recall-exact-shadow`. It does not replace
 * `recall`, does not rank, and does not write. It binds to the current session
 * from the tool exec context; there is no path parameter. Source is
 * `sessionQuery.readSession(sessionId)` / `observeSession`.
 */
const ASCII_WORD = /[0-9a-z]/;
const CJK = /[\u3400-\u9fff]/;
const SINGLE_CHAR_WHITELIST = new Set(['创']);
const TOO_BROAD_INTERVALS = 20;
const CACHE_LIMIT = 2;
const SESSION_CACHE = new Map();
const INJECTED = /^\[(?:continuity:|追忆|抽取|工作线|标签|规则|规矩|习惯|技能|归位|候选|存\?|闸|回正|学习|记忆|创|peer)|^<system-reminder>|^Current runtime context|^Time sampled while preparing/i;

function normalizeText(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase();
}

function extractBlocks(events) {
  const blocks = [];
  const excluded = { reasoning: 0, toolCall: 0, other: 0, injected: 0 };
  let currentTurn = null;
  for (const event of events) {
    const type = String(event?.type ?? '');
    if (type === 'turn/start') {
      const turn = Number(event?.data?.turn);
      if (Number.isInteger(turn)) currentTurn = turn;
      continue;
    }
    if (type !== 'user/message' && type !== 'assistant/message') continue;
    const content = type === 'assistant/message'
      ? event?.data?.message?.content ?? event?.data?.content
      : event?.data?.content ?? event?.data?.message?.content;
    let text = '';
    for (const block of content ?? []) {
      if (!block) continue;
      if (block.type === 'text') text += block.text ?? '';
      else if (block.type === 'reasoning') excluded.reasoning += 1;
      else if (block.type === 'tool-call' || block.type === 'tool_call') excluded.toolCall += 1;
      else excluded.other += 1;
    }
    text = text.trim();
    if (!text) continue;
    if (INJECTED.test(text)) {
      excluded.injected += 1;
      continue;
    }
    const rawSeq = Number(event.seq);
    blocks.push({
      seq: Number.isInteger(rawSeq) ? rawSeq : null,
      turn: Number.isInteger(event?.data?.turn) ? Number(event.data.turn) : currentTurn,
      role: type === 'user/message' ? 'user' : 'assistant',
      ts: Number.isFinite(Number(event.time)) ? new Date(Number(event.time)).toISOString() : String(event.ts ?? ''),
      text,
      norm: normalizeText(text),
    });
  }
  blocks.excluded = excluded;
  blocks.currentTurn = currentTurn;
  return blocks;
}

async function loadBlocks(sessionQuery, sessionId) {
  let events = [];
  let revision = null;
  if (typeof sessionQuery.observeSession === 'function') {
    const observation = await sessionQuery.observeSession(sessionId, { projectionMode: 'none' });
    try {
      events = Array.isArray(observation?.events) ? [...observation.events] : [];
      revision = observation?.revision ?? null;
    } finally {
      if (typeof observation?.[Symbol.dispose] === 'function') observation[Symbol.dispose]();
    }
  } else {
    const snapshot = await sessionQuery.readSession(sessionId);
    events = Array.isArray(snapshot?.events) ? snapshot.events : [];
    revision = events.length > 0 ? events[events.length - 1]?.seq ?? null : null;
  }
  const lastSeq = events.length > 0 ? events[events.length - 1]?.seq ?? null : null;
  const key = `${events.length}|${String(revision)}|${String(lastSeq)}`;
  const cached = SESSION_CACHE.get(sessionId);
  if (cached && cached.key === key) return { blocks: cached.blocks, cache: 'hit' };
  const blocks = extractBlocks(events);
  if (SESSION_CACHE.size >= CACHE_LIMIT) SESSION_CACHE.delete(SESSION_CACHE.keys().next().value);
  SESSION_CACHE.set(sessionId, { key, blocks });
  return { blocks, cache: 'miss' };
}

function boundaryHit(norm, at, length) {
  const before = at === 0 ? '' : norm[at - 1];
  const after = at + length >= norm.length ? '' : norm[at + length];
  return !ASCII_WORD.test(before) && !ASCII_WORD.test(after);
}

function countOccurrences(block, query) {
  const norm = block.norm ?? normalizeText(block.text);
  if (!norm.includes(query)) return 0;
  let count = 0;
  let from = 0;
  while (from <= norm.length - query.length) {
    const at = norm.indexOf(query, from);
    if (at < 0) break;
    if (boundaryHit(norm, at, query.length)) count += 1;
    from = at + Math.max(1, query.length);
  }
  return count;
}

function groupIntervals(items) {
  const sorted = [...items].sort((a, b) => a.turn - b.turn || (a.seq ?? 0) - (b.seq ?? 0));
  const groups = [];
  for (const item of sorted) {
    const last = groups.at(-1);
    const seq = Number.isInteger(item.seq) ? item.seq : null;
    if (last && item.turn - last.toTurn <= 1) {
      last.toTurn = item.turn;
      last.toSeq = seq;
      if (seq !== null) last.seqEnd = Math.max(last.seqEnd ?? seq, seq);
      last.occurrences += item.occurrences;
      last.hits += 1;
    } else {
      groups.push({
        fromTurn: item.turn,
        toTurn: item.turn,
        fromSeq: seq,
        toSeq: seq,
        seqEnd: seq,
        occurrences: item.occurrences,
        hits: 1,
      });
    }
  }
  return groups;
}

function fail(error) {
  return JSON.stringify({ ok: false, error });
}

export function createRecallExactTool({ sessionQuery }) {
  return {
    name: 'recall_exact',
    description: 'Read-only exact token/substring search over the current session. Use when recall returned tooBroad or a K hit that is too wide; it is a parallel channel and never replaces recall. It searches visible user + assistant text only (no reasoning/tool-call), returns grouped turn/seq intervals plus totalTurns/totalIntervals/turnShare, and does not rank or write.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Exact token or substring. ASCII tokens use [0-9A-Za-z] boundaries; non-ASCII uses substring matching; single CJK chars must be whitelisted.' },
        since: { type: 'integer', description: 'Optional inclusive lower turn bound.' },
        until: { type: 'integer', description: 'Optional inclusive upper turn bound.' },
        near: { type: 'integer', description: 'Optional center turn; cannot be combined with since/until.' },
        window: { type: 'integer', description: 'Turn radius for near; defaults to 20.' },
        limit: { type: 'integer', description: 'Maximum returned intervals; default 20, max 200. Totals are never truncated.' },
      },
      required: ['query'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    timeoutMs: 30_000,
    async execute(args = {}, exec = {}) {
      const queryRaw = String(args.query ?? '').trim();
      if (!queryRaw) return fail('query-required');
      const query = normalizeText(queryRaw);
      if (CJK.test(query) && [...query].length === 1 && !SINGLE_CHAR_WHITELIST.has(query)) {
        return fail('single-char-cjk-not-whitelisted');
      }
      const numberArg = (key) => {
        if (args[key] === undefined || args[key] === null) return null;
        const value = Number(args[key]);
        return Number.isFinite(value) && Number.isInteger(value) ? value : NaN;
      };
      const since = numberArg('since');
      const until = numberArg('until');
      const near = numberArg('near');
      const windowRaw = numberArg('window');
      const limitRaw = numberArg('limit');
      if ([since, until, near, windowRaw, limitRaw].some(Number.isNaN)) return fail('bounds-must-be-integers');
      if (near !== null && (since !== null || until !== null)) return fail('near-cannot-be-combined-with-since-until');
      const window = near === null ? null : Math.max(1, windowRaw ?? 20);
      const limit = Math.min(Math.max(limitRaw ?? 20, 1), 200);
      const sessionId = exec?.agent?.session?.id;
      if (sessionId === undefined || sessionId === null) return fail('current-session-required');
      const started = Date.now();
      let loaded;
      try {
        loaded = await loadBlocks(sessionQuery, sessionId);
      } catch (error) {
        return fail(`session-read-failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const { blocks, cache } = loaded;
      const loadMs = Date.now() - started;
      let skippedNoTurn = 0;
      const selected = [];
      for (const block of blocks) {
        if (!Number.isInteger(block.turn)) { skippedNoTurn += 1; continue; }
        if (near !== null && Math.abs(block.turn - near) > window) continue;
        if (near === null && since !== null && block.turn < since) continue;
        if (near === null && until !== null && block.turn > until) continue;
        selected.push(block);
      }
      const matches = [];
      for (const block of selected) {
        const occurrences = countOccurrences(block, query);
        if (occurrences > 0) matches.push({ ...block, occurrences });
      }
      const intervals = groupIntervals(matches);
      const turns = new Set(matches.map((match) => match.turn));
      const roleTurns = { user: new Set(), assistant: new Set() };
      for (const match of matches) roleTurns[match.role].add(match.turn);
      const sessionTurns = new Set(blocks.map((block) => block.turn).filter(Number.isInteger)).size;
      const turnShare = sessionTurns > 0 ? Number((turns.size / sessionTurns).toFixed(3)) : null;
      const nullSeq = matches.filter((match) => !Number.isInteger(match.seq)).length;
      const days = new Map();
      for (const match of matches) {
        const day = String(match.ts).slice(0, 10) || 'unknown';
        const entry = days.get(day) ?? { turns: new Set(), blocks: 0 };
        entry.blocks += 1;
        entry.turns.add(match.turn);
        days.set(day, entry);
      }
      const histogram = Object.fromEntries([...days.entries()].map(([day, value]) => [day, {
        turns: value.turns.size,
        blocks: value.blocks,
      }]));
      const wideByIntervals = intervals.length > TOO_BROAD_INTERVALS;
      const tooBroad = wideByIntervals && (turnShare === null || turnShare >= 0.2);
      const report = {
        ok: true,
        query: queryRaw,
        source: 'sessionQuery',
        sessionScope: 'current session id from exec; no path parameter',
        surface: 'user+assistant.text',
        mode: 'token/substring',
        scope: near !== null
          ? { unit: 'turn', near, window }
          : { unit: 'turn', since, until },
        cache,
        loadMs,
        skippedNoTurn,
        nullSeq,
        surfaceStats: {
          userBlocks: blocks.filter((block) => block.role === 'user').length,
          assistantBlocks: blocks.filter((block) => block.role === 'assistant').length,
          excluded: blocks.excluded ?? { reasoning: 0, toolCall: 0, other: 0, injected: 0 },
        },
        totalTurns: turns.size,
        totalIntervals: intervals.length,
        shown: Math.min(limit, intervals.length),
        wideByIntervals,
        tooBroad,
        tooBroadBy: tooBroad ? 'intervals+turnShare' : 'none',
        turnShare,
        roleTurns: { user: roleTurns.user.size, assistant: roleTurns.assistant.size },
        firstTurn: intervals[0]?.fromTurn ?? null,
        lastTurn: intervals.at(-1)?.toTurn ?? null,
        histogram,
        note: 'read-only; exact token/substring only; no reasoning/tool-call; tooBroad = intervals>20 AND turnShare>=0.2; use recall_exact when recall is too broad',
        hits: intervals.slice(0, limit),
      };
      return JSON.stringify(report);
    },
  };
}
