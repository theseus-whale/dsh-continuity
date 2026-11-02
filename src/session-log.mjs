/**
 * Read-only retrieval over one session's raw event log.
 *
 * Pure functions: the tool layer supplies the `SessionEvent[]` from
 * `ctx.sessionQuery.readSession()`. Nothing here appends, replaces, projects,
 * or otherwise mutates a session. Tests can feed frozen fixtures.
 *
 * Sequence semantics: `seq` is the session event seq, the same number a
 * `[gist · log:...#seq=A-B]` pointer carries. Surface spans can be
 * non-monotonic (a replacement inserts a new high seq at an old position), so
 * a range that exactly matches a compaction's `shadowedRange` is resolved
 * through that compaction's `shadowedSeqs` instead of a numeric filter.
 */

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const DEFAULT_MAX_CHARS = 16_000;
export const INDEX_MAX_CHARS = 12_000;
export const GREP_MAX_CHARS = 12_000;
export const MAX_EVENT_CHARS = 2_400;
export const MAX_SNIPPET_CHARS = 240;
export const MAX_CONTEXT = 10;

export class SessionLogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SessionLogError';
    this.code = code;
  }
}

const ROLE_BY_TYPE = Object.freeze({
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'tool',
  'tool/call': 'tool-call',
  'system/message': 'system',
  'developer/message': 'developer',
  'compaction/summary': 'gist',
  'compaction/start': 'compaction',
  'compaction/end': 'compaction',
  'compaction/prune': 'compaction',
  'turn/start': 'turn',
  'turn/end': 'turn',
  'step/start': 'step',
  'step/end': 'step',
  'request/header': 'request',
  'request/context': 'request',
});

/** Clamp to an integer in [min, max]. */
function clampInt(value, min, max, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function formatTime(time) {
  const number = Number(time);
  if (!Number.isFinite(number)) return 'time=?';
  try {
    return new Date(number).toISOString();
  } catch {
    return 'time=?';
  }
}

function truncate(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}… [truncated ${value.length - max} chars]`;
}

function oneLine(text, max) {
  return truncate(String(text ?? '').replace(/\s+/g, ' ').trim(), max);
}

function blockText(blocks, options = {}) {
  const includeReasoning = options.includeReasoning !== false;
  const parts = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block == null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'reasoning' && typeof block.text === 'string' && includeReasoning) parts.push(`[reasoning] ${block.text}`);
    else if (block.type === 'tool-call') parts.push(`[tool-call ${block.name ?? ''}] ${block.arguments ?? ''}`);
    else if (block.type === 'file') parts.push(`[file ${block.attachment?.name ?? ''}]`);
    else if (block.type === 'image') parts.push('[image]');
  }
  return parts.join('\n');
}

/** Model-visible text carried by one event, or '' for marker-only events.
 * `includeReasoning: false` drops reasoning blocks; the scan/load default. */
export function eventText(event, options = {}) {
  const data = event?.data;
  if (data == null) return '';
  if (Array.isArray(data)) return blockText(data, options);
  if (Array.isArray(data.summary)) return blockText(data.summary, options);
  if (Array.isArray(data.content)) return blockText(data.content, options);
  if (Array.isArray(data.message?.content)) return blockText(data.message.content, options);
  if (typeof data.arguments === 'string') return `${data.name ?? ''} ${data.arguments}`;
  if (typeof data.text === 'string') return data.text;
  return '';
}

/** Short role bucket used in the manifest. */
export function eventRole(event) {
  return ROLE_BY_TYPE[event?.type] ?? String(event?.type ?? 'event');
}

/** One-line description for marker events; text events return their text. */
export function eventSummary(event) {
  const data = event?.data ?? {};
  switch (event?.type) {
    case 'turn/start':
      return `turn ${data.turn ?? '?'} start`;
    case 'turn/end':
      return `turn ${data.turn ?? '?'} end ${data.reason?.kind ?? '?'}`;
    case 'step/start':
      return `turn ${data.turn ?? '?'} step ${data.step ?? '?'} start`;
    case 'step/end':
      return `turn ${data.turn ?? '?'} step ${data.step ?? '?'} end`;
    case 'request/header':
      return `request ${data.header?.config?.provider ?? '?'}/${data.header?.config?.model ?? '?'}`
        + ` maxTokens=${data.header?.config?.maxTokens ?? '?'} tools=${data.header?.tools?.length ?? 0}`;
    case 'request/context':
      return `request context ${data.provider ?? '?'}/${data.model ?? '?'} window=${data.contextWindow ?? '?'}`;
    case 'compaction/start':
      return `compaction ${data.compactionId ?? '?'} start`;
    case 'compaction/end':
      return `compaction ${data.compactionId ?? '?'} end${data.error ? ` error=${data.error.message ?? data.error}` : ''}`;
    case 'compaction/prune':
      return `prune ${data.shadowedRange?.start ?? '?'}-${data.shadowedRange?.end ?? '?'}`
        + ` ~${data.shadowedTokenCount ?? '?'} tokens`;
    case 'compaction/summary':
      return `compaction ${data.compactionId ?? '?'} summary`;
    default:
      return String(event?.type ?? 'event');
  }
}

/** First `[gist …]` line in a compaction summary, if any. */
export function gistHeaderOf(event) {
  const text = eventText(event);
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[gist') || trimmed.startsWith('[thread')) return trimmed;
  }
  return null;
}

const ROLE_ORDER = Object.freeze([
  'user', 'assistant', 'tool', 'tool-call', 'gist', 'developer', 'system',
  'compaction', 'turn', 'step', 'request',
]);

function rolesOf(events) {
  const counts = new Map();
  for (const event of events) {
    const role = eventRole(event);
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  const ordered = ROLE_ORDER.filter((role) => counts.has(role));
  const rest = [...counts.keys()].filter((role) => !ROLE_ORDER.includes(role)).sort();
  return [...ordered, ...rest]
    .map((role) => `${role}:${counts.get(role)}`)
    .join(' ');
}

function seqBounds(events) {
  if (!Array.isArray(events) || events.length === 0) return { min: null, max: null };
  let min = Infinity;
  let max = -Infinity;
  for (const event of events) {
    const seq = Number(event?.seq);
    if (!Number.isFinite(seq)) continue;
    if (seq < min) min = seq;
    if (seq > max) max = seq;
  }
  if (min === Infinity) return { min: null, max: null };
  return { min, max };
}

function findGist(events, start, end) {
  return events
    .filter((event) => event?.type === 'compaction/summary'
      && Number(event.data?.shadowedRange?.start) === start
      && Number(event.data?.shadowedRange?.end) === end)
    .at(-1) ?? null;
}

function formatEventForGet(event) {
  const text = eventText(event);
  const body = text.trim().length > 0 ? text : eventSummary(event);
  return `seq=${event.seq} [${eventRole(event)}] ${formatTime(event.time)}\n${truncate(body, MAX_EVENT_CHARS)}`;
}

/**
 * List compaction/gist ranges, newest first.
 * @returns {{ text: string, total: number, returned: number, truncated: boolean }}
 */
export function buildIndex({ sessionId, events, limit = DEFAULT_LIMIT, maxChars = INDEX_MAX_CHARS }) {
  const list = Array.isArray(events) ? events : [];
  const gists = list
    .filter((event) => event?.type === 'compaction/summary')
    .sort((left, right) => Number(right.seq) - Number(left.seq));
  const lines = [
    `session_log index · session=${sessionId} · events=${list.length} · gists=${gists.length}`,
  ];
  if (gists.length === 0) {
    lines.push('no gist records in this session.');
    lines.push('Use grep with a literal term to locate raw events, then get <seq> or get start-end.');
    return { text: lines.join('\n'), total: 0, returned: 0, truncated: false };
  }

  const take = clampInt(limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
  const shown = [];
  let used = lines.join('\n').length;
  for (const gist of gists.slice(0, take)) {
    const data = gist.data ?? {};
    const header = gistHeaderOf(gist) ?? '(manual compaction; no gist header)';
    const line = `- seq=${gist.seq} · surface ${data.shadowedRange?.start ?? '?'}-${data.shadowedRange?.end ?? '?'}`
      + ` · ${data.shadowedSeqs?.length ?? '?'} msgs · ~${data.shadowedTokenCount ?? '?'} tok`
      + ` · ${formatTime(gist.time)} · ${data.provider ?? '?'}/${data.model ?? '?'}`
      + `\n  ${header}`;
    if (used + line.length > maxChars) break;
    shown.push(line);
    used += line.length + 1;
  }
  lines.push(...shown);
  if (shown.length < gists.length) {
    lines.push(`[showing ${shown.length} of ${gists.length} gists, newest first; raise limit or grep to narrow]`);
  }
  return {
    text: lines.join('\n'),
    total: gists.length,
    returned: shown.length,
    truncated: shown.length < gists.length,
  };
}

/**
 * Read one event, one seq ± context, or one inclusive range.
 *
 * A range matching a compaction's `shadowedRange` is resolved to that
 * compaction's exact `shadowedSeqs` (surface order, possibly non-monotonic).
 * @returns {{ text: string, total: number, returned: number, truncated: boolean }}
 */
export function getRange({
  sessionId,
  events,
  seq,
  start,
  end,
  context = 0,
  limit = DEFAULT_LIMIT,
  maxChars = DEFAULT_MAX_CHARS,
}) {
  const list = Array.isArray(events) ? events : [];
  const bounds = seqBounds(list);
  const hasSeq = seq !== undefined && seq !== null && seq !== '';
  const hasStart = start !== undefined && start !== null && start !== '';
  const hasEnd = end !== undefined && end !== null && end !== '';
  if (!hasSeq && !(hasStart && hasEnd)) {
    throw new SessionLogError(
      'RANGE_REQUIRED',
      'get needs seq, or start and end. Use index to list gist ranges; without a pointer use grep then get <seq>.',
    );
  }
  if (!hasSeq && hasStart !== hasEnd) {
    throw new SessionLogError('RANGE_PARTIAL', 'get needs both start and end, or a single seq.');
  }

  let selected = [];
  let label = '';
  let resolvedGist = null;

  if (hasSeq) {
    const wanted = Number(seq);
    const index = list.findIndex((event) => Number(event.seq) === wanted);
    if (index < 0) {
      throw new SessionLogError(
        'SEQ_NOT_FOUND',
        `seq ${seq} is not in this session (valid event seqs ${bounds.min ?? '?'}-${bounds.max ?? '?'}).`
        + ' If the original is unavailable, say you only remember the gist.',
      );
    }
    const span = clampInt(context, 0, MAX_CONTEXT, 0);
    selected = list.slice(Math.max(0, index - span), Math.min(list.length, index + span + 1));
    label = `seq=${wanted}${span > 0 ? ` ±${span}` : ''}`;
  } else {
    const from = Number(start);
    const to = Number(end);
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      throw new SessionLogError('RANGE_INVALID', 'start and end must be integer event seqs.');
    }
    const gist = findGist(list, from, to);
    if (gist !== null) {
      const seqs = Array.isArray(gist.data?.shadowedSeqs) ? gist.data.shadowedSeqs : [];
      const bySeq = new Map(list.map((event) => [Number(event.seq), event]));
      selected = seqs.map((value) => bySeq.get(Number(value))).filter((event) => event !== undefined);
      if (selected.length > 0) {
        resolvedGist = gist.data?.compactionId ?? 'unknown';
        label = `surface ${from}-${to}`;
      }
    }
    if (selected.length === 0 && from <= to) {
      selected = list.filter((event) => Number(event.seq) >= from && Number(event.seq) <= to);
      label = `event seqs ${from}-${to}`;
    }
    if (selected.length === 0 && from > to) {
      throw new SessionLogError(
        'RANGE_ORDER',
        `surface range ${from}-${to} is not numerically ordered and matches no compaction summary.`
        + ' Pass the exact gist pointer (session=log:<id>#seq=A-B) or a start <= end range.',
      );
    }
  }

  if (selected.length === 0) {
    throw new SessionLogError(
      'RANGE_EMPTY',
      `no events in ${label || 'that range'} (valid event seqs ${bounds.min ?? '?'}-${bounds.max ?? '?'}).`
      + ' If the original is unavailable, say you only remember the gist.',
    );
  }

  const take = clampInt(limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
  const manifest = [
    `session_log get · session=${sessionId} · ${label} · events=${selected.length}`
      + (resolvedGist === null ? '' : ` · resolved via gist ${resolvedGist}`),
    `roles: ${rolesOf(selected)}`,
  ];
  const body = [];
  let used = manifest.join('\n').length;
  let returned = 0;
  for (const event of selected.slice(0, take)) {
    const text = formatEventForGet(event);
    if (used + text.length > maxChars) {
      if (returned === 0) {
        body.push(truncate(text, maxChars));
        returned = 1;
      }
      break;
    }
    body.push(text);
    used += text.length + 2;
    returned += 1;
  }
  if (returned < selected.length) {
    const next = selected[returned]?.seq;
    manifest.push(
      `[truncated: showing ${returned} of ${selected.length}; next seq=${next ?? '?'};`
      + ' get seq=<next> ±context, raise limit, or grep to narrow]',
    );
  }
  return {
    text: [...manifest, ...body].join('\n\n'),
    total: selected.length,
    returned,
    truncated: returned < selected.length,
  };
}

/**
 * Literal case-insensitive search over raw event text.
 * @returns {{ text: string, total: number, returned: number, truncated: boolean }}
 */
export function grepRange({
  sessionId,
  events,
  query,
  context = 0,
  limit = DEFAULT_LIMIT,
  maxChars = GREP_MAX_CHARS,
}) {
  const list = Array.isArray(events) ? events : [];
  const needle = String(query ?? '').trim();
  if (needle.length < 2) {
    throw new SessionLogError('QUERY_REQUIRED', 'grep needs a query of at least 2 characters.');
  }
  const lower = needle.toLowerCase();
  const matches = [];
  for (const event of list) {
    // The system prompt is not conversation; searching it produces noise
    // (including this plugin's own convention text). get <seq> can still read it.
    if (event?.type === 'system/message') continue;
    const text = eventText(event);
    if (text.length === 0) continue;
    const index = text.toLowerCase().indexOf(lower);
    if (index < 0) continue;
    const before = text.slice(Math.max(0, index - 80), index).replace(/\s+/g, ' ');
    const after = text.slice(index + needle.length, index + needle.length + 120).replace(/\s+/g, ' ');
    matches.push({
      seq: event.seq,
      role: eventRole(event),
      time: event.time,
      snippet: `…${before}${text.slice(index, index + needle.length)}${after}…`,
    });
  }
  matches.sort((left, right) => Number(left.seq) - Number(right.seq));

  const lines = [`session_log grep · session=${sessionId} · query="${needle}" · matches=${matches.length}`];
  if (matches.length === 0) {
    lines.push('no matches; try another term or a shorter phrase.');
    lines.push('If the original is unavailable, say you only remember the gist.');
    return { text: lines.join('\n'), total: 0, returned: 0, truncated: false };
  }

  const span = clampInt(context, 0, MAX_CONTEXT, 0);
  const take = clampInt(limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
  const shown = matches.slice(0, take);
  const body = [];
  let used = lines.join('\n').length;
  for (const match of shown) {
    const line = `seq=${match.seq} [${match.role}] ${formatTime(match.time)}: ${truncate(match.snippet, MAX_SNIPPET_CHARS)}`;
    let chunk = line;
    if (span > 0) {
      const index = list.findIndex((event) => Number(event.seq) === Number(match.seq));
      for (let offset = -span; offset <= span; offset += 1) {
        if (offset === 0) continue;
        const neighbor = list[index + offset];
        if (neighbor === undefined) continue;
        const text = eventText(neighbor);
        const preview = text.trim().length > 0 ? text : eventSummary(neighbor);
        chunk += `\n  ${offset < 0 ? 'before' : 'after'} seq=${neighbor.seq} [${eventRole(neighbor)}] ${formatTime(neighbor.time)}: ${oneLine(preview, 120)}`;
      }
    }
    if (used + chunk.length > maxChars) {
      if (body.length === 0) body.push(truncate(chunk, maxChars));
      break;
    }
    body.push(chunk);
    used += chunk.length + 1;
  }
  lines.push(...body);
  if (body.length < matches.length) {
    lines.push(`[truncated: showing ${body.length} of ${matches.length} matches; raise limit or refine the query]`);
  }
  return {
    text: lines.join('\n'),
    total: matches.length,
    returned: body.length,
    truncated: body.length < matches.length,
  };
}

/** Parse `log:<id>#seq=A-B` (also inside a full gist header) or a plain id. */
export function parsePointer(value) {
  const text = String(value ?? '').trim();
  if (text.length === 0) return { sessionId: null, start: null, end: null, pointer: false };
  const match = /log:([^\s#·]+)#seq=(\d+)-(\d+)/.exec(text);
  if (match !== null) {
    return {
      sessionId: match[1],
      start: Number(match[2]),
      end: Number(match[3]),
      pointer: true,
    };
  }
  return { sessionId: text, start: null, end: null, pointer: false };
}

/** Ordered categories used by `session_log stats`. */
export const STATS_CATEGORIES = Object.freeze([
  'reasoning',
  'tool_result',
  'assistant_text',
  'tool_call',
  'user',
  'system',
  'developer',
  'gist',
]);

function pushTextBlocks(blocks, category, source) {
  if (!Array.isArray(blocks)) return;
  let chars = 0;
  let count = 0;
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      chars += block.text.length;
      count += 1;
    }
  }
  if (chars > 0 || count > 0) source.push({ category, chars, count });
}

/**
 * Classify one event into stats categories. Assistant text, reasoning and
 * tool-call arguments are separate; `tool/call` markers are skipped because the
 * assistant message already carries the call arguments.
 * @returns {{ category: string, chars: number, count: number }[]}
 */
export function classifyStatsEvent(event) {
  const out = [];
  const data = event?.data;
  if (data === null || data === undefined) return out;
  switch (event?.type) {
    case 'user/message':
      pushTextBlocks(data.content, 'user', out);
      break;
    case 'developer/message':
      pushTextBlocks(data.content, 'developer', out);
      break;
    case 'system/message':
      pushTextBlocks(data.message?.content ?? data.content, 'system', out);
      break;
    case 'assistant/message': {
      const blocks = data.message?.content;
      if (!Array.isArray(blocks)) break;
      let text = 0;
      let reasoning = 0;
      let toolCall = 0;
      let textBlocks = 0;
      let reasoningBlocks = 0;
      let callBlocks = 0;
      for (const block of blocks) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          text += block.text.length;
          textBlocks += 1;
        } else if (block?.type === 'reasoning' && typeof block.text === 'string') {
          reasoning += block.text.length;
          reasoningBlocks += 1;
        } else if (block?.type === 'tool-call') {
          toolCall += String(block.name ?? '').length + String(block.arguments ?? '').length;
          callBlocks += 1;
        }
      }
      if (reasoning > 0 || reasoningBlocks > 0) out.push({ category: 'reasoning', chars: reasoning, count: reasoningBlocks });
      if (text > 0 || textBlocks > 0) out.push({ category: 'assistant_text', chars: text, count: textBlocks });
      if (toolCall > 0 || callBlocks > 0) out.push({ category: 'tool_call', chars: toolCall, count: callBlocks });
      break;
    }
    case 'tool/result':
      pushTextBlocks(data.message?.content, 'tool_result', out);
      break;
    case 'compaction/summary':
      pushTextBlocks(data.summary, 'gist', out);
      break;
    default:
      break;
  }
  return out;
}

/**
 * Aggregate events into token/char rows. `tokensBySeq` (surface mode) provides
 * route-priced tokens per event; within a multi-block assistant event the event
 * token count is split across categories by chars. Without it, chars/4 is used
 * and the caller must label the result as an estimate.
 * @returns {{ totalChars: number, totalTokens: number, rows: object[] }}
 */
export function buildStats(events, { tokensBySeq = null } = {}) {
  const byCategory = new Map();
  let totalChars = 0;
  let totalTokens = 0;
  for (const event of Array.isArray(events) ? events : []) {
    const categories = classifyStatsEvent(event);
    if (categories.length === 0) continue;
    const eventChars = categories.reduce((sum, entry) => sum + entry.chars, 0);
    const nodeTokens = tokensBySeq?.get(Number(event.seq));
    const eventTokens = Number.isFinite(nodeTokens) ? nodeTokens : eventChars / 4;
    for (const entry of categories) {
      const row = byCategory.get(entry.category) ?? { category: entry.category, count: 0, chars: 0, tokens: 0 };
      row.count += entry.count;
      row.chars += entry.chars;
      row.tokens += eventChars > 0 ? eventTokens * (entry.chars / eventChars) : 0;
      byCategory.set(entry.category, row);
    }
    totalChars += eventChars;
    totalTokens += eventTokens;
  }
  const rows = [...byCategory.values()].sort((left, right) => right.tokens - left.tokens);
  return { totalChars, totalTokens, rows };
}

/** Surface seqs in the newest `tailTokens` route-priced budget. */
export function tailSeqs(surfaceSeqs, tokensBySeq, tailTokens) {
  const selected = new Set();
  if (!Array.isArray(surfaceSeqs) || !Number.isFinite(tailTokens) || tailTokens <= 0) return selected;
  let accumulated = 0;
  for (let index = surfaceSeqs.length - 1; index >= 0; index -= 1) {
    const seq = surfaceSeqs[index];
    const tokens = Number(tokensBySeq?.get(Number(seq)) ?? 0);
    if (accumulated + tokens > tailTokens && accumulated > 0) break;
    selected.add(seq);
    accumulated += tokens;
  }
  return selected;
}

