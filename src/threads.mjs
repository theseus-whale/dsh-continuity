/**
 * Continuity threads — pure formatting, range selection, and load selection.
 *
 * The tool layer owns session mutation and persistence; this module only
 * decides what a save would cover, what a load would quote, and what the
 * per-turn active line says. Keeping it pure makes the two dangerous pieces
 * (tool-call pairing and the load budget) testable without a live agent.
 */
import { randomUUID } from 'node:crypto';
import { eventRole, eventText } from './session-log.mjs';
import { normalizeTags } from './tags.mjs';

export const DEFAULT_LOAD_BUDGET = 8_000;
export const MAX_LOAD_BUDGET = 20_000;
export const REASONING_LOAD_BUDGET = 16_000;
export const REASONING_MAX_TOKENS = 800;
export const REASONING_HEAD_TOKENS = 150;
export const REASONING_TAIL_TOKENS = 650;
export const RULES_MAX_TOKENS = 400;
export const ACTIVE_LINE_MAX_TOKENS = 200;
export const RESIDUE_MAX_CHARS = 4_000;
export const MAX_SAVE_MESSAGES = 200;

/** Cheap conservative token estimate: CJK ≈ 1 token/char, ASCII ≈ 4 chars/token. */
export function estimateTextTokens(text) {
  const value = String(text ?? '');
  if (value.length === 0) return 0;
  const cjk = (value.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
  return Math.ceil(cjk + (value.length - cjk) / 4);
}

/**
 * Truncate to an estimated token budget. The suffix says the text was cut.
 * @param {string} text
 * @param {number} maxTokens
 * @param {(text: string) => number} [estimate]
 */
export function truncateToTokens(text, maxTokens, estimate = estimateTextTokens) {
  const value = String(text ?? '');
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return '';
  if (estimate(value) <= maxTokens) return value;
  const suffix = '\n… [truncated]';
  const suffixTokens = estimate(suffix);
  const budget = Math.max(0, maxTokens - suffixTokens);
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimate(value.slice(0, middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low).trimEnd()}${suffix}`;
}

/** One-line display text. */
export function oneLine(text, max = 120) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function minutesBetween(start, end) {
  const from = Number.isFinite(Number(start)) ? Number(start) : null;
  const to = Number.isFinite(Number(end)) ? Number(end) : null;
  if (from === null || to === null || to < from) return 0;
  return Math.max(0, Math.round(((to - from) / 60_000) * 10) / 10);
}

export function isoOf(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  try {
    return new Date(number).toISOString();
  } catch {
    return null;
  }
}

/** Human span for a thread. */
export function spanLabel(thread) {
  const start = thread.spanStart ?? '?';
  const end = thread.spanEnd ?? '?';
  const minutes = Number.isFinite(thread.minutes) ? `${thread.minutes}m` : '?m';
  return `${start} → ${end} (${minutes})`;
}

/** 12.3k / 980 for save receipts. */
export function formatTokenCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return '?';
  if (number >= 1000) return `${(number / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(number));
}

/** Local HH:mm for the list/active "最近" label. */
export function formatClock(value) {
  const number = Date.parse(String(value ?? ''));
  if (!Number.isFinite(number)) return '--:--';
  const date = new Date(number);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Normalize one segment; old single-range threads pass the thread as both. */
export function normalizeSegment(raw, thread = {}) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const fromSeq = source.fromSeq ?? source.seqStart ?? thread.seqStart ?? null;
  const toSeq = source.toSeq ?? source.seqEnd ?? thread.seqEnd ?? null;
  const seqs = Array.isArray(source.seqs)
    ? source.seqs
    : Array.isArray(thread.seqs) ? thread.seqs : [fromSeq, toSeq].filter((seq) => seq !== null);
  const count = Number.isFinite(source.count) ? source.count : Number.isFinite(thread.count) ? thread.count : seqs.length;
  const tokens = Number.isFinite(source.tokens) ? source.tokens : Number.isFinite(thread.tokens) ? thread.tokens : 0;
  const why = typeof source.why === 'string' ? source.why : (typeof thread.why === 'string' ? thread.why : '');
  const next = typeof source.next === 'string' ? source.next : (typeof thread.next === 'string' ? thread.next : '');
  const residue = typeof source.residue === 'string' ? source.residue : (typeof thread.residue === 'string' ? thread.residue : undefined);
  const spanStart = source.spanStart ?? thread.spanStart ?? null;
  const spanEnd = source.spanEnd ?? thread.spanEnd ?? null;
  // Old backfill segments stored the write moment in `at`; their `why` starts
  // with 历史回补. Normalize them to content time on read.
  const isBackfill = source.archivedAt !== undefined || /^历史回补/.test(String(source.why ?? ''));
  const at = isBackfill
    ? (spanEnd ?? source.at ?? thread.createdAt ?? thread.spanStart ?? new Date().toISOString())
    : (source.at ?? thread.createdAt ?? thread.spanStart ?? new Date().toISOString());
  // Preserve an old backfill's write moment instead of discarding it when `at`
  // is normalized to content time.
  const archivedAt = source.archivedAt
    ?? (isBackfill && source.at !== undefined && source.at !== spanEnd ? source.at : undefined);
  const minutes = Number.isFinite(source.minutes) ? source.minutes : Number.isFinite(thread.minutes) ? thread.minutes : 0;
  const archiveRef = source.archiveRef ?? `log:${thread.sessionId ?? 'session'}#seq=${fromSeq}-${toSeq}`;
  const tCoverage = source.tCoverage ?? thread.tCoverage;
  return {
    fromSeq,
    toSeq,
    seqs,
    count,
    tokens,
    why,
    next,
    ...(residue === undefined ? {} : { residue }),
    at,
    ...(archivedAt === undefined ? {} : { archivedAt }),
    spanStart,
    spanEnd,
    minutes,
    archiveRef,
    ...(tCoverage === undefined ? {} : { tCoverage }),
    ...(source.gistSeq === undefined && thread.gistSeq === undefined ? {} : { gistSeq: source.gistSeq ?? thread.gistSeq }),
    ...(source.compactionId === undefined && thread.compactionId === undefined
      ? {}
      : { compactionId: source.compactionId ?? thread.compactionId }),
  };
}

/** Read-time compatibility: old one-range threads become a one-segment thread.
 * Write-time callers use the normalized shape returned here. */
export function normalizeThread(input) {
  const source = input !== null && typeof input === 'object' ? { ...input } : {};
  const segments = (Array.isArray(source.segments) && source.segments.length > 0
    ? source.segments.map((segment) => normalizeSegment(segment, source))
    : [normalizeSegment(source, source)])
    // Backfill may insert a historical segment; "last = newest" is an invariant
    // for every reader, so normalize order by seq rather than trusting append order.
    .sort((left, right) => Number(left.fromSeq) - Number(right.fromSeq));
  const first = segments[0];
  const latest = segments[segments.length - 1];
  const tokens = segments.reduce((sum, segment) => sum + (Number(segment.tokens) || 0), 0);
  const minutes = segments.reduce((sum, segment) => sum + (Number(segment.minutes) || 0), 0);
  const normalized = {
    ...source,
    segments,
    seqStart: first.fromSeq,
    seqEnd: latest.toSeq,
    seqs: latest.seqs,
    count: latest.count,
    spanStart: first.spanStart,
    spanEnd: latest.spanEnd,
    minutes,
    tokens,
    why: latest.why,
    next: latest.next,
    archiveRef: latest.archiveRef,
    ...(latest.residue === undefined ? {} : { residue: latest.residue }),
    ...(latest.gistSeq === undefined ? {} : { gistSeq: latest.gistSeq }),
    ...(latest.compactionId === undefined ? {} : { compactionId: latest.compactionId }),
    // Recency is content recency, not the write time of a backfill.
    updatedAt: latest.spanEnd ?? latest.at,
  };
  if (latest.residue === undefined) delete normalized.residue;
  return normalized;
}

/** One thread's gist body; starts with [thread], then a retrievable [gist]. */
export function threadGistText(thread) {
  const normalized = normalizeThread(thread);
  const segments = normalized.segments;
  const segment = segments[segments.length - 1];
  const index = segments.length;
  const total = segments.length;
  const lines = [
    `[thread] ${normalized.label} · segment ${index}/${total} · thread=${index} · T=${segment.tCoverage ?? 'T0'} · ${spanLabel(segment)} · 收起因为:${segment.why} · 下一步:${segment.next} · 存档:${segment.archiveRef} · seq ${segment.fromSeq}..${segment.toSeq}`,
  ];
  if (typeof segment.residue === 'string' && segment.residue.trim().length > 0) {
    lines.push(`残留:${segment.residue.trim()}`);
  }
  lines.push(
    `[gist · log:${normalized.sessionId ?? 'session'}#seq=${segment.fromSeq}-${segment.toSeq}`
    + ` · ${segment.count ?? '?'} messages · original retrievable via session_log]`,
  );
  return lines.join('\n');
}

/** A surface user message carrying a registered runtime-context snapshot.
 * `user` is accepted by v4 but renders as a human chat bubble; `runtime-context`
 * is a producer-owned kind and renders as a context block, which is where the
 * per-turn active line and rules belong. */
export function contextMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'runtime-context',
      form: 'snapshot',
      sections: [{ name: 'continuity:threads', text }],
    },
  };
}

/** A real user-role message. Every user/message event must carry source.kind;
 * projection and agent.steer read it directly. */
export function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text ?? '') }],
    source: { kind: 'user' },
  };
}

/** A same-turn gate notice. `steer` only admits user-looking messages in some
 * hosts; runtime-context is projected/filtered before it reaches the model.
 * Use a user source so the notice is actually admitted; the [闸] marker makes
 * clear it is not the person typing. */
export function gateMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text ?? '') }],
    source: { kind: 'user' },
  };
}

/** Rules are must-read and editable; the constitution itself references them. */
export const RULES_ATTRIBUTION = '[规矩] 宪法要求你必须读当前 session 的 rules.md；它是可修改的规矩，不是不可改的宪法。';

export const RULES_PATH = '~/.dsh/continuity/rules.md';
export const HABITS_PATH = '~/.dsh/continuity/habits.md';

/** Active line only; the closed-label list moves to the compact [标签] line. */
export function activeLine(state, options = {}) {
  const threads = Array.isArray(state?.threads) ? state.threads : [];
  const pointerThread = threads.find((thread) => thread.id === state?.activeId) ?? null;
  const current = threads.find((thread) => thread.active === true) ?? pointerThread;
  const lines = [];
  if (current !== null) {
    const segments = Array.isArray(current.segments) ? current.segments : [];
    const segmentCount = segments.length;
    const tokens = segments.reduce((sum, segment) => sum + (Number(segment.tokens) || 0), 0);
    const symbol = oneLine(current.alias ?? current.label ?? current.id, 40);
    const activity = pointerThread !== null && pointerThread.id !== current.id
      ? `（活动：${oneLine(pointerThread.alias ?? pointerThread.label ?? pointerThread.id, 40)}）`
      : '';
    lines.push(`[工作线] ${oneLine(current.label, 60)}（${segmentCount} 段 · ${tokens} tokens）${activity} · 下一步：${oneLine(current.next, 100)}`);
  } else {
    lines.push('[工作线] 无');
  }
  const text = lines.join('\n');
  const maxTokens = Number.isFinite(options.maxTokens) ? options.maxTokens : ACTIVE_LINE_MAX_TOKENS;
  return truncateToTokens(text, maxTokens);
}

/** H2 headings as a one-line habit summary; never the full rules text. */
export function summarizeRules(text, maxChars = 220) {
  const headings = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.match(/^##\s+(.+?)\s*$/)?.[1])
    .filter(Boolean)
    .map((heading) => heading.replace(/[：:]\s*$/, ''));
  if (headings.length === 0) return '按自己的判断使用';
  const summary = headings.join(' · ');
  if (summary.length <= maxChars) return summary;

  // Keep the truncation honest: say how many sections exist and how many fit.
  for (let shown = headings.length - 1; shown > 0; shown -= 1) {
    const suffix = `…（共 ${headings.length} 节，仅显示前 ${shown} 节）`;
    const candidate = `${headings.slice(0, shown).join(' · ')}${suffix}`;
    if (candidate.length <= maxChars) return candidate;
  }
  return oneLine(summary, maxChars);
}

/** Compact [标签] status line: active only, plus the count of other tags. */
export function tagStatusLine(state, tagRows) {
  const rows = Array.isArray(tagRows) ? tagRows : [];
  const threads = Array.isArray(state?.threads) ? state.threads : [];
  const active = threads.find((thread) => thread.id === state?.activeId) ?? null;
  const otherRows = rows.filter((row) => row.id !== 'T0');
  if (active === null) {
    return `[标签] T 未定 · 另有 ${otherRows.length} 条`;
  }
  const alias = typeof active.alias === 'string' && active.alias.trim().length > 0 ? active.alias.trim() : null;
  const row = rows.find((entry) => entry.id === alias || entry.id === active.id)
    ?? rows.find((entry) => entry.threadId === active.id);
  const display = row?.display ?? alias ?? oneLine(active.label, 40);
  const others = rows.filter((entry) => entry.id !== row?.id && entry.id !== active.id && entry.id !== 'T0').length;
  // 遗忘率 = T0 事件 / 全部已标记事件。它衡量"认知漏掉了多少"，不是"桶有多大"。
  const t0 = rows.find((entry) => entry.id === 'T0') ?? null;
  const totalEvents = rows.reduce((sum, entry) => sum + (Number(entry.events) || 0), 0);
  const t0Events = Number(t0?.events ?? 0) || 0;
  const forget = totalEvents > 0
    ? ` · 未覆盖 ${t0Events}（${((t0Events / totalEvents) * 100).toFixed(1)}%，含结构事件）`
    : '';
  return `[标签] ${display} · 另有 ${others} 条${forget}`;
}

/** Compose the once-per-turn context block: line(s) + one-line habits summary. */
export function threadContextText(line, rulesSummary, habitsSummary = '', paths = {}) {
  const parts = [];
  if (typeof line === 'string' && line.trim().length > 0) parts.push(line.trim());
  if (typeof rulesSummary === 'string' && rulesSummary.trim().length > 0) {
    parts.push(`[规则] Continuity 自己的硬规则（AGENTS 要求必须读；只改这份，不改 AGENTS）：${rulesSummary.trim()} · 全文 ${paths.rules ?? RULES_PATH}`);
  }
  if (typeof habitsSummary === 'string' && habitsSummary.trim().length > 0) {
    parts.push(`[习惯] Continuity 自己的软偏好（与 rules 冲突时让位；只改这份）：${habitsSummary.trim()} · 全文 ${paths.habits ?? HABITS_PATH}`);
  }
  return parts.join('\n');
}

/** Load header + quoted raw. Accepts the latest segment explicitly so a
 * multi-segment thread says which segment supplied the backfill. */
export function threadLoadText(thread, segmentOrQuote, quoteValue, segmentIndex, segmentCount, note, foldedNote, reasoningInfo) {
  const normalized = normalizeThread(thread);
  const explicit = segmentOrQuote !== null && typeof segmentOrQuote === 'object'
    && (segmentOrQuote.fromSeq !== undefined || segmentOrQuote.toSeq !== undefined);
  const segment = explicit
    ? normalizeSegment(segmentOrQuote, normalized)
    : normalized.segments[normalized.segments.length - 1];
  const quote = explicit ? quoteValue : segmentOrQuote;
  const total = Number.isFinite(segmentCount) ? segmentCount : normalized.segments.length;
  const index = Number.isFinite(segmentIndex) ? segmentIndex : normalized.segments.length;
  const scope = typeof note === 'string' && note.trim().length > 0 ? note.trim() : `第${index}/${total}段`;
  return [
    `[放] ${normalized.label} · ${scope} · 现在算在「${normalized.id}」这条线上 · 下一步:${segment.next} · 上次收:${segment.why} · 存档:${segment.archiveRef}`,
    ...(foldedNote !== null && foldedNote !== undefined && String(foldedNote).length > 0
      ? [`[已折叠于 gist seq=${foldedNote}]`]
      : []),
    ...(reasoningInfo !== null && reasoningInfo !== undefined
      ? [`[reasoning] 含 ${reasoningInfo.reasoningInjected} 条 · skipped ${reasoningInfo.skipped}`]
      : []),
    scope.startsWith('第') ? '—— 以下是从原文取回的最后一段 ——' : '—— 以下是从原文取回的所选内容 ——',
    String(quote ?? ''),
  ].join('\n');
}

/** The index-only fallback used when the raw journal is missing. */
export function threadLoadIndexOnly(thread, segmentIndex, segmentCount, note, foldedNote) {
  const normalized = normalizeThread(thread);
  const segment = normalized.segments[normalized.segments.length - 1];
  const total = Number.isFinite(segmentCount) ? segmentCount : normalized.segments.length;
  const index = Number.isFinite(segmentIndex) ? segmentIndex : normalized.segments.length;
  const scope = typeof note === 'string' && note.trim().length > 0 ? note.trim() : `第${index}/${total}段`;
  return [
    `[放] ${normalized.label} · ${scope} · 现在算在「${normalized.id}」这条线上 · 下一步:${segment.next} · 上次收:${segment.why} · 存档:${segment.archiveRef}`,
    ...(foldedNote !== null && foldedNote !== undefined && String(foldedNote).length > 0
      ? [`[已折叠于 gist seq=${foldedNote}]`]
      : []),
    '—— 原文不可用；只有索引 ——',
  ].join('\n');
}

/** Latest turn/start seq in this session, or null. */
export function latestTurnStartSeq(session) {
  const end = Number.isInteger(session?.seq) ? session.seq : 0;
  for (let seq = end - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt?.(seq);
    if (event?.type === 'turn/start') return seq;
  }
  return null;
}

function isGistNode(event) {
  const text = eventText(event).trimStart();
  return text.startsWith('[gist') || text.startsWith('[thread');
}

/**
 * Select and validate the save range.
 *
 * Explicit from/to must be exact surface endpoints and both balanced; a cut is
 * rejected with the offending seq. The default range starts after the latest
 * gist and ends before the current open turn, then walks inward until both ends
 * are pairing-balanced. The current turn is never folded.
 *
 * @param {object} input
 * @param {object} input.session
 * @param {number|string} [input.fromSeq]
 * @param {number|string} [input.toSeq]
 * @param {number|string} [input.minStartSeq] default save only: never start before this seq
 * @param {{ before: (session: object, seq: number|string) => boolean, after: (session: object, seq: number|string) => boolean }} input.pairing
 * @returns {{ startSeq: number|string, endSeq: number|string, startIdx: number, endIdx: number, shadowedSeqs: Array<number|string>, count: number, adjusted: boolean }}
 */
export function selectSaveRange({ session, fromSeq, toSeq, pairing, maxMessages = MAX_SAVE_MESSAGES, minStartSeq }) {  const nodes = session?.surface?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) throw new Error('save: session has no surface');
  if (typeof pairing?.before !== 'function' || typeof pairing?.after !== 'function') {
    throw new Error('save: pairing predicates are unavailable');
  }
  const explicitStart = fromSeq !== undefined && fromSeq !== null && fromSeq !== '';
  const explicitEnd = toSeq !== undefined && toSeq !== null && toSeq !== '';
  if (explicitStart !== explicitEnd) throw new Error('save: pass both fromSeq and toSeq, or neither');

  const turnStart = latestTurnStartSeq(session);
  let startIdx;
  let endIdx;
  let adjusted = false;

  if (explicitStart) {
    startIdx = nodes.findIndex((seq) => Number(seq) === Number(fromSeq));
    endIdx = nodes.findIndex((seq) => Number(seq) === Number(toSeq));
    if (startIdx < 0) throw new Error(`save: fromSeq ${fromSeq} is not a surface node`);
    if (endIdx < 0) throw new Error(`save: toSeq ${toSeq} is not a surface node`);
    if (startIdx > endIdx) throw new Error('save: fromSeq is after toSeq on the surface');
    if (turnStart !== null && Number(nodes[endIdx]) >= turnStart) {
      throw new Error('save: the current open turn is not foldable; save a range that ends before this turn');
    }
    for (let index = startIdx; index <= endIdx; index += 1) {
      if (isGistNode(session.eventAt(nodes[index]))) {
        throw new Error(`save: surface seq ${nodes[index]} is a gist/thread node; start after the previous gist`);
      }
    }
    if (!pairing.before(session, nodes[startIdx])) {
      throw new Error(`save: fromSeq ${fromSeq} cuts a tool call/result pair (unbalanced before); choose an earlier boundary`);
    }
    if (!pairing.after(session, nodes[endIdx])) {
      throw new Error(`save: toSeq ${toSeq} cuts a tool call/result pair (unbalanced after); choose a later boundary`);
    }
  } else {
    endIdx = nodes.length - 1;
    if (turnStart !== null) {
      while (endIdx >= 0 && Number(nodes[endIdx]) >= turnStart) endIdx -= 1;
    }
    startIdx = 0;
    if (nodes.length > 0 && session.eventAt(nodes[0])?.type === 'system/message') startIdx = 1;
    for (let index = endIdx; index >= startIdx; index -= 1) {
      if (isGistNode(session.eventAt(nodes[index]))) {
        startIdx = index + 1;
        break;
      }
    }
    if (startIdx > endIdx) throw new Error('save: no completed, non-gist range to save');

    // Default save must not cross into an earlier T. The caller passes the
    // start of the tag run containing the selected end; explicit from/to is
    // intentionally not clamped.
    if (minStartSeq !== undefined && minStartSeq !== null && minStartSeq !== '') {
      const min = Number(minStartSeq);
      if (!Number.isFinite(min)) throw new Error('save: minStartSeq must be a number');
      const minIdx = nodes.findIndex((seq) => Number(seq) >= min);
      if (minIdx < 0 || minIdx > endIdx) {
        throw new Error('save: the current T run starts after the completed range');
      }
      if (minIdx > startIdx) {
        startIdx = minIdx;
        adjusted = true;
      }
    }

    while (startIdx < endIdx && !pairing.before(session, nodes[startIdx])) {
      startIdx += 1;
      adjusted = true;
    }
    while (endIdx > startIdx && !pairing.after(session, nodes[endIdx])) {
      endIdx -= 1;
      adjusted = true;
    }
    if (!pairing.before(session, nodes[startIdx])) {
      throw new Error(`save: no balanced start after the previous gist (seq ${nodes[startIdx]})`);
    }
    if (!pairing.after(session, nodes[endIdx])) {
      throw new Error(`save: no balanced end before the open turn (seq ${nodes[endIdx]})`);
    }
    for (let index = startIdx; index <= endIdx; index += 1) {
      if (isGistNode(session.eventAt(nodes[index]))) {
        throw new Error(`save: the selected range contains gist/thread node ${nodes[index]}; start after it`);
      }
    }
  }

  if (startIdx < 0 || endIdx < 0 || startIdx > endIdx) throw new Error('save: selected range is empty');
  const countMessages = (from, to) => {
    let count = 0;
    for (let index = from; index <= to; index += 1) {
      if (session.deriveEventMessage?.(session.eventAt(nodes[index])) !== null) count += 1;
    }
    return count;
  };
  if (!explicitStart && Number.isInteger(maxMessages) && maxMessages > 0) {
    while (startIdx < endIdx && countMessages(startIdx, endIdx) > maxMessages) {
      startIdx += 1;
      adjusted = true;
    }
    while (startIdx < endIdx && !pairing.before(session, nodes[startIdx])) {
      startIdx += 1;
      adjusted = true;
    }
  }
  const shadowedSeqs = nodes.slice(startIdx, endIdx + 1);
  const count = countMessages(startIdx, endIdx);
  if (count === 0) throw new Error('save: selected range contains no message-producing node');
  return {
    startSeq: nodes[startIdx],
    endSeq: nodes[endIdx],
    startIdx,
    endIdx,
    shadowedSeqs,
    count,
    adjusted,
  };
}

/** Start of the T dominance block ending at seq. Own runs always join; other
 * runs of <= islandMax events are override islands to cross; a larger other
 * run is a real boundary. Returns null if seq has no containing run. */
export function dominanceStartSeq(tags, endSeq, { islandMax = 5 } = {}) {
  const state = normalizeTags(tags);
  const end = Number(endSeq);
  if (!Number.isInteger(end)) return null;
  let current = null;
  for (let index = state.runs.length - 1; index >= 0; index -= 1) {
    const run = state.runs[index];
    if (end >= run[0] && end <= run[1]) { current = run; break; }
  }
  if (current === null) return null;
  const currentId = current[2];
  let start = current[0];
  const earlier = state.runs
    .filter((run) => run[0] < start)
    .sort((left, right) => right[0] - left[0]);
  for (const [from, to, id] of earlier) {
    if (to >= start) {
      if (id === currentId) start = Math.min(start, from);
      continue;
    }
    if (id === currentId) {
      start = from;
      continue;
    }
    const length = to - from + 1;
    if (length > islandMax) break;
  }
  return start;
}

/** Text carried by one raw event, with reasoning removed by default. */
export function quoteEventText(event) {
  return eventText(event, { includeReasoning: false }).trim();
}

/** Coarse category used by `scan`; raw event types and roles are also accepted
 * by the `types` filter. */
function scanType(event) {
  switch (event?.type) {
    case 'user/message':
    case 'assistant/message':
    case 'system/message':
    case 'developer/message':
      return 'message';
    case 'tool/result':
      return 'tool-result';
    case 'tool/call':
      return 'tool-call';
    case 'compaction/summary':
      return 'gist';
    case 'compaction/start':
    case 'compaction/end':
    case 'compaction/prune':
      return 'compaction';
    case 'turn/start':
    case 'turn/end':
      return 'turn';
    case 'step/start':
    case 'step/end':
      return 'step';
    case 'request/header':
    case 'request/context':
      return 'request';
    default:
      return String(event?.type ?? 'event');
  }
}

function isSyntheticMessage(event, text) {
  if (event?.type !== 'user/message') return false;
  const kind = event?.data?.source?.kind;
  if (kind === 'runtime-context' || kind === 'compact-checkpoint') return true;
  return text.startsWith('This is an automatically generated checkpoint')
    || text.startsWith('[gist')
    || text.startsWith('[thread');
}

/** Maximum estimated tokens for one scan payload. */
export const SCAN_LIST_MAX_TOKENS = 900;
export const SCAN_DEFAULT_HEAD_CHARS = 160;
export const SCAN_MAX_HEAD_CHARS = 200;
export const SCAN_DEFAULT_LIMIT = 20;
export const SCAN_MAX_LIMIT = 100;

/**
 * Cheap event index for one seq range. It never injects context and never
 * summarizes: it returns seq/role/type/head/chars/tokens so the caller can pick
 * exact seqs for a ranged load. Defaults: message events, no reasoning, 160-char
 * heads, synthetic runtime-context/checkpoint messages skipped, and a payload
 * budget below 1k estimated tokens.
 */
export function scanEvents({
  events,
  fromSeq,
  toSeq,
  seqs = null,
  headChars = SCAN_DEFAULT_HEAD_CHARS,
  includeReasoning = false,
  types = null,
  limit = SCAN_DEFAULT_LIMIT,
  maxListTokens = SCAN_LIST_MAX_TOKENS,
  estimate = estimateTextTokens,
}) {
  const from = Number(fromSeq);
  const to = Number(toSeq);
  const explicitSeqs = Array.isArray(seqs)
    ? [...new Set(seqs.map((seq) => Number(seq)).filter((seq) => Number.isInteger(seq)))]
    : null;
  if (explicitSeqs === null) {
    if (!Number.isInteger(from) || !Number.isInteger(to)) throw new Error('scan: fromSeq and toSeq must be integers');
    if (from > to) throw new Error('scan: fromSeq must be <= toSeq');
  } else if (explicitSeqs.length === 0) {
    throw new Error('scan: seqs must contain at least one integer seq');
  }
  const maxHead = Math.min(SCAN_MAX_HEAD_CHARS, Math.max(20, Math.trunc(Number(headChars) || SCAN_DEFAULT_HEAD_CHARS)));
  const maxItems = Math.min(SCAN_MAX_LIMIT, Math.max(1, Math.trunc(Number(limit) || SCAN_DEFAULT_LIMIT)));
  const filter = Array.isArray(types) && types.length > 0 ? types.map(String) : ['message'];
  const wanted = explicitSeqs === null ? null : new Set(explicitSeqs);
  const ordered = (Array.isArray(events) ? events : [])
    .filter((event) => {
      const seq = Number(event?.seq);
      if (!Number.isInteger(seq)) return false;
      if (wanted !== null) return wanted.has(seq);
      return seq >= from && seq <= to;
    })
    .sort((left, right) => Number(left.seq) - Number(right.seq));

  const items = [];
  let listTokens = 0;
  for (const event of ordered) {
    const type = scanType(event);
    const role = eventRole(event);
    if (!filter.some((entry) => entry === type || entry === event.type || entry === role)) continue;
    const text = eventText(event, { includeReasoning }).trim();
    if (text.length === 0) continue;
    if (isSyntheticMessage(event, text)) continue;
    const head = oneLine(text, maxHead);
    const item = {
      seq: Number(event.seq),
      role,
      type,
      head,
      chars: text.length,
      tokens: estimate(text),
    };
    const cost = estimate(head) + 12;
    if (items.length > 0 && listTokens + cost > maxListTokens) break;
    items.push(item);
    listTokens += cost;
    if (items.length >= maxItems) break;
  }
  return items;
}

/**
 * Select the newest segment of a thread's original events under a token budget.
 * Reasoning-only events are skipped; the last non-empty event is included.
 * @returns {{ selected: object[], tokens: number, missing: boolean }}
 */
export function selectLoadSegment({ seqs, bySeq, budget, estimate = estimateTextTokens }) {
  const selected = [];
  let tokens = 0;
  if (!Array.isArray(seqs) || seqs.length === 0) return { selected, tokens, missing: true };
  for (let index = seqs.length - 1; index >= 0; index -= 1) {
    const seq = seqs[index];
    const event = bySeq.get(Number(seq));
    if (event === undefined) return { selected: [], tokens: 0, missing: true };
    const text = quoteEventText(event);
    if (text.length === 0) continue;
    const eventTokens = estimate(text);
    if (selected.length > 0 && tokens + eventTokens > budget) break;
    selected.unshift({ seq, event, role: eventRole(event), text, tokens: eventTokens });
    tokens += eventTokens;
    if (tokens >= budget) break;
  }
  return { selected, tokens, missing: false };
}

/** Quote selected events without copying their node seqs. */
export function quoteSelected(selected) {
  return selected.map((entry) => `[${entry.role}] ${entry.text}`).join('\n\n');
}

function reasoningBlocksOf(event) {
  const data = event?.data;
  const blocks = Array.isArray(data?.message?.content)
    ? data.message.content
    : Array.isArray(data?.content) ? data.content : Array.isArray(data) ? data : [];
  return blocks
    .filter((block) => block?.type === 'reasoning' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter(Boolean);
}

function reasoningTextOf(event) {
  return reasoningBlocksOf(event).join('\n');
}

function takeHeadTokens(text, maxTokens) {
  if (estimateTextTokens(text) <= maxTokens) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTextTokens(text.slice(0, middle)) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low).trimEnd();
}

function takeTailTokens(text, maxTokens) {
  if (estimateTextTokens(text) <= maxTokens) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTextTokens(text.slice(text.length - middle)) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return text.slice(text.length - low).trimStart();
}

/** 150-head + 650-tail when one reasoning block exceeds 800 estimated tokens. */
export function truncateReasoning(text) {
  const value = String(text ?? '').trim();
  if (estimateTextTokens(value) <= REASONING_MAX_TOKENS) {
    return { text: value, truncated: false };
  }
  const head = takeHeadTokens(value, REASONING_HEAD_TOKENS);
  const tail = takeTailTokens(value, REASONING_TAIL_TOKENS);
  return {
    text: `${head}\n… [reasoning truncated] …\n${tail}`,
    truncated: true,
  };
}

/** Nearest reasoning inside the assistant message, or immediately before it in
 * the same turn. A reasoning-only event is consumed once. */
function pairedReasoningFor(entry, bySeq, used) {
  if (entry?.event?.type !== 'assistant/message') return null;
  const own = reasoningTextOf(entry.event);
  if (own.length > 0) return own;
  for (let seq = Number(entry.seq) - 1; seq >= 0; seq -= 1) {
    const previous = bySeq.get(seq);
    if (previous === undefined) continue;
    if (previous.type === 'turn/start' || previous.type === 'turn/end') break;
    const body = quoteEventText(previous);
    if (body.length > 0) break;
    const reasoning = reasoningTextOf(previous);
    if (reasoning.length === 0) continue;
    if (used.has(seq)) return null;
    used.add(seq);
    return reasoning;
  }
  return null;
}

function reasoningLine(entry) {
  if (typeof entry.reasoningText !== 'string' || entry.reasoningText.length === 0) return '';
  return `[reasoning${entry.reasoningTruncated ? ' · 截断' : ''}]\n${entry.reasoningText}`;
}

/** Chronological reasoning load under one body+reasoning budget. */
export function applyReasoningBudget({
  selected,
  bySeq,
  budget = REASONING_LOAD_BUDGET,
} = {}) {
  const ordered = [...(Array.isArray(selected) ? selected : [])]
    .sort((left, right) => Number(left.seq) - Number(right.seq));
  const used = new Set();
  const kept = [];
  let tokens = 0;
  let reasoningInjected = 0;
  let reasoningTokens = 0;
  let skipped = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const entry = ordered[index];
    const rawReasoning = pairedReasoningFor(entry, bySeq, used);
    const reasoning = rawReasoning === null ? null : truncateReasoning(rawReasoning);
    const line = reasoning === null ? '' : reasoningLine({
      reasoningText: reasoning.text,
      reasoningTruncated: reasoning.truncated,
    });
    const rendered = `[${entry.role}] ${entry.text}${line.length > 0 ? `\n\n${line}` : ''}`;
    const cost = estimateTextTokens(rendered);
    if (tokens + cost > budget) {
      skipped = ordered.length - index;
      break;
    }
    const enriched = reasoning === null
      ? { ...entry }
      : {
        ...entry,
        reasoningText: reasoning.text,
        reasoningTruncated: reasoning.truncated,
        reasoningTokens: estimateTextTokens(reasoning.text),
      };
    kept.push(enriched);
    tokens += cost;
    if (reasoning !== null) {
      reasoningInjected += 1;
      reasoningTokens += estimateTextTokens(reasoning.text);
    }
  }
  return { selected: kept, tokens, reasoningInjected, reasoningTokens, skipped };
}

/** Quote reasoning loads chronologically; reasoning stays separate from body. */
export function quoteSelectedWithReasoning(selected) {
  return [...(Array.isArray(selected) ? selected : [])]
    .sort((left, right) => Number(left.seq) - Number(right.seq))
    .map((entry) => `[${entry.role}] ${entry.text}${reasoningLine(entry).length > 0 ? `\n\n${reasoningLine(entry)}` : ''}`)
    .join('\n\n');
}

/** Surface seqs that must survive automatic compaction for the active thread. */
export function activePinSeqsFromState(state, surfaceNodes) {
  const pins = new Set();
  const active = Array.isArray(state?.threads)
    ? state.threads.find((thread) => thread.id === state.activeId)
    : null;
  if (active === null || active === undefined) return pins;
  const candidates = [active.loadSeq, active.anchorSeq];
  for (const seq of candidates) {
    if (seq === undefined || seq === null || seq === '') continue;
    if (surfaceNodes.some((node) => Number(node) === Number(seq))) pins.add(seq);
  }
  return pins;
}

function latestSegmentOf(thread) {
  if (Array.isArray(thread?.segments) && thread.segments.length > 0) {
    return thread.segments[thread.segments.length - 1];
  }
  return normalizeSegment(thread, thread);
}

function segmentCountOf(thread) {
  return Array.isArray(thread?.segments) && thread.segments.length > 0
    ? thread.segments.length
    : 1;
}

/** `active` tool result. */
export function activeView(state) {
  const threads = Array.isArray(state?.threads) ? state.threads : [];
  const active = threads.find((thread) => thread.id === state?.activeId) ?? null;
  if (active === null) return null;
  const latest = latestSegmentOf(active);
  const segments = segmentCountOf(active);
  return {
    id: active.id,
    label: active.label,
    next: latest.next,
    closed: threads.filter((thread) => thread.id !== active.id).length,
    segments,
    lastAt: latest.at,
    display: `${active.label} · ${segments} 段 · 最近 ${formatClock(latest.at)}`,
  };
}

/** `list` tool result. */
export function listView(state) {
  const threads = Array.isArray(state?.threads) ? state.threads : [];
  return threads.map((thread) => {
    const latest = latestSegmentOf(thread);
    const segments = segmentCountOf(thread);
    return {
      id: thread.id,
      label: thread.label,
      active: Boolean(thread.active),
      span: `${thread.spanStart ?? '?'} → ${thread.spanEnd ?? '?'}`,
      minutes: thread.minutes,
      tokens: thread.tokens,
      segments,
      lastAt: latest.at,
      display: `${thread.label} · ${segments} 段 · 最近 ${formatClock(latest.at)}`,
    };
  });
}

/** Thread summary returned to the model. */
export function threadView(thread) {
  const latest = latestSegmentOf(thread);
  return {
    id: thread.id,
    label: thread.label,
    span: `${thread.spanStart ?? '?'} → ${thread.spanEnd ?? '?'}`,
    minutes: thread.minutes,
    tokens: thread.tokens,
    seqStart: thread.seqStart,
    seqEnd: thread.seqEnd,
    active: Boolean(thread.active),
    segments: segmentCountOf(thread),
    lastAt: latest.at,
  };
}
