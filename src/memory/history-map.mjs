/**
 * Active history map: the middle-layer summary that must live in context.
 *
 * This renderer is deliberately deterministic: it uses the archive summary
 * index plus the newest raw summary events, and caps by characters/tokens.
 * A later LLM summarizer can replace the body; the carrier contract stays.
 */
import { createHash } from 'node:crypto';

const DEFAULT_MAX_TOKENS = 4000;
const CHARS_PER_TOKEN = 4;
const DETAIL_CHARS = 6000;

function textOfSummary(event) {
  const summary = event?.data?.summary;
  if (Array.isArray(summary)) {
    return summary.map((block) => (block && typeof block === 'object' && typeof block.text === 'string' ? block.text : '')).join('');
  }
  return typeof summary === 'string' ? summary : '';
}

function seqOf(event) {
  const seq = Number(event?.seq);
  return Number.isInteger(seq) ? seq : null;
}

function rangeOf(event) {
  const start = Number(event?.data?.shadowedRange?.start);
  const end = Number(event?.data?.shadowedRange?.end);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  return { from: Math.min(start, end), to: Math.max(start, end) };
}

function mergeRanges(records) {
  const ranges = records
    .map((record) => ({ from: Number(record.fromSeq), to: Number(record.toSeq) }))
    .filter((range) => Number.isInteger(range.from) && Number.isInteger(range.to))
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.from <= last.to + 1) last.to = Math.max(last.to, range.to);
    else merged.push({ ...range });
  }
  return merged;
}

function excerpt(text, maxChars = DETAIL_CHARS) {
  const clean = String(text ?? '').replace(/\r/g, '').trim().replace(/^## /gm, '### ');
  if (clean.length <= maxChars) return clean;
  return clean.slice(0, maxChars).replace(/\s+\S*$/, '') + '…';
}

/**
 * @param {{index?: object, events?: object[], maxTokens?: number, generatedAt?: string}} input
 */
export function buildHistoryMap({ index = null, events = [], maxTokens = DEFAULT_MAX_TOKENS, generatedAt = null } = {}) {
  const capChars = Math.max(1000, Math.floor(maxTokens * CHARS_PER_TOKEN));
  const records = Array.isArray(index?.records) ? index.records : [];
  const ranges = mergeRanges(records);
  const rawSummaries = (Array.isArray(events) ? events : [])
    .filter((event) => event?.type === 'compaction/summary')
    .map((event) => ({ seq: seqOf(event), range: rangeOf(event), text: textOfSummary(event), event }))
    .filter((item) => item.range && item.text.trim().length > 0)
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const indexedMax = Number(index?.maxSummarySeq);
  const latestRaw = rawSummaries.at(-1) ?? null;
  const extra = rawSummaries.filter((item) => !Number.isInteger(indexedMax) || (item.seq ?? -1) > indexedMax);

  const sections = [];
  const push = (heading, body) => sections.push({ heading, body: String(body ?? '').trim() });
  push(
    '位置',
    [
      `session=${index?.sessionId ?? ''}`,
      `coverage=${index?.coverage?.minSeq ?? '?'}..${index?.coverage?.maxSeq ?? '?'}`,
      `index.maxSummarySeq=${indexedMax || '?'}`,
      `latestRawSummary=${latestRaw?.seq ?? '?'}`,
      `depth=1`,
      `generatedAt=${generatedAt ?? index?.generatedAt ?? 'unknown'}`,
    ].join(' · '),
  );
  const recentRanges = ranges.slice(-3).reverse();
  for (const range of recentRanges) {
    const candidates = records
      .filter((record) => Number(record.toSeq) >= range.from && Number(record.fromSeq) <= range.to)
      .sort((a, b) => Number(b.toSeq) - Number(a.toSeq)
        || String(b.text ?? '').length - String(a.text ?? '').length);
    const picked = candidates.slice(0, 2);
    if (picked.length > 0) {
      const perRecord = Math.max(1500, Math.floor(DETAIL_CHARS / picked.length));
      push(
        `最近区间 ${range.from}-${range.to}`,
        picked.map((record) => excerpt(record.text, perRecord)).join('\n\n---\n\n'),
      );
    }
  }
  if (extra.length > 0) {
    push(
      '上次索引之后的 fold',
      extra.slice(-2).map((item) => `- seq ${item.range.from}-${item.range.to}: ${excerpt(item.text, 1200)}`).join('\n'),
    );
  }
  push(
    '长期结构',
    ranges.length === 0
      ? '(no archive ranges)'
      : ranges.map((range) => `- seq ${range.from}-${range.to}`).join('\n'),
  );
  push('取原文', '细节以 raw session_log 为准；本图只指路，不是事实本身。');

  // Cap by sections, dropping detail from the middle first; keep position/source.
  let text = '';
  const rendered = [];
  for (const section of sections) {
    const block = `## ${section.heading}\n${section.body}`;
    if (text.length + block.length + 2 > capChars && rendered.length > 0) {
      if (section.heading === '取原文') {
        text += `\n\n## ${section.heading}\n${section.body}`;
      }
      continue;
    }
    rendered.push(block);
    text += (text ? '\n\n' : '') + block;
  }
  if (text.length > capChars) text = text.slice(0, capChars).replace(/\s+\S*$/, '') + '…';
  const hash = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
  return {
    text: `[continuity:history-map] ${text}`,
    hash,
    maxTokens,
    chars: text.length,
    approxTokens: Math.ceil(text.length / CHARS_PER_TOKEN),
    maxSummarySeq: Number.isInteger(indexedMax) ? indexedMax : null,
    coveredThroughSeq: Number.isInteger(Number(index?.coveredThroughSeq)) ? Number(index.coveredThroughSeq) : null,
    latestRawSummarySeq: latestRaw?.seq ?? null,
    extraFolds: extra.length,
  };
}
