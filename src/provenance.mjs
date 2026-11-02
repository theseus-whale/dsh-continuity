/**
 * Provenance labels for compacted memory. Pure functions; no DSH imports.
 *
 * The point is not to announce a compaction event, but to make the result
 * carry its own epistemic status: a block tagged `[gist]` is a reconstruction,
 * with a pointer back to the original. A reader can then say "I only remember
 * the gist" instead of mistaking the summary for verbatim memory.
 */

/** One standing convention for the system prompt; not a per-event banner. */
export const SYSTEM_CONVENTION = [
  'Blocks tagged [gist] are reconstructions, not verbatim memory.',
  'Use the gist when it is enough; before quoting an exact phrase, date, number, promise, or name, retrieve the original with session_log.',
  'If the gist header has seq=A-B, call session_log get for that session and range.',
  'If a gist contains an older gist pointer, follow the older pointer to the original.',
  'Without a pointer, call session_log index, then grep, then get the matching seq ± context.',
  'For a large range, get a preview or grep first and narrow; do not dump it.',
  'Tool-result previews are truncations, not verbatim output; if the exact tool output matters, call session_log get seq=<n> for the cited original.',
  'A [tool result handle] replaces a non-text payload; the payload is archived, so inspect the handle and retrieve the original by seq or attachment path before relying on it.',
  'If a [continuity pause] handle appears, do not retry that tool or keep compressing: tell the user the context window is too small and ask them to raise it, while preserving the session.',
  'If the original is unavailable, say you only remember the gist; stop after 2–3 fetches.',
].join(' ');

export const LABEL = Object.freeze({
  verbatim: '[verbatim]',
  gist: '[gist]',
  uncertain: '[uncertain]',
  open: '[open]',
});

/**
 * Header for one compacted block.
 *
 * @param {{ pointer?: string, sessionId?: string, startSeq?: number|string, endSeq?: number|string, count?: number, t?: string }} input
 * @returns {string} e.g. `[gist · log:main#seq=120-154 · T=T3 · 34 messages · original retrievable via session_log]`
 */
export function gistHeader({ pointer, sessionId, startSeq, endSeq, count, t } = {}) {
  let where = pointer?.trim() || '';
  if (!where) {
    if (sessionId == null || startSeq == null || endSeq == null) {
      throw new Error('gistHeader needs a pointer or a session id with a seq range');
    }
    where = `log:${sessionId}#seq=${startSeq}-${endSeq}`;
  }
  const suffix = Number.isFinite(count) && count > 0 ? ` · ${count} messages` : '';
  const tags = typeof t === 'string' && t.trim().length > 0 ? ` · T=${t.trim()}` : '';
  return `[gist · ${where}${tags}${suffix} · original retrievable via session_log]`;
}

/**
 * Render one labeled block. Empty sections are omitted; order is fixed:
 * verbatim, gist, uncertain, open.
 *
 * @param {{ header: string, verbatim?: string[], gist?: string[], uncertain?: string[], open?: string[] }} input
 * @returns {string}
 */
export function renderGistBlock({ header, verbatim = [], gist = [], uncertain = [], open = [] } = {}) {
  if (typeof header !== 'string' || !header.startsWith('[gist')) {
    throw new Error('renderGistBlock needs the header from gistHeader()');
  }
  const lines = [header];
  const push = (tag, items) => {
    for (const item of items) {
      const text = String(item ?? '').trim();
      if (text) lines.push(`- ${tag} ${text}`);
    }
  };
  push(LABEL.verbatim, verbatim);
  push(LABEL.gist, gist);
  push(LABEL.uncertain, uncertain);
  push(LABEL.open, open);
  return lines.join('\n');
}

/**
 * Prepend a gist header to the first text block of a summary, without touching
 * the other blocks. Used by an engine's `summarize()` hook.
 *
 * @param {Array<Record<string, unknown>>} blocks
 * @param {string} header
 * @returns {Array<Record<string, unknown>>}
 */
export function annotateSummary(blocks, header) {
  if (typeof header !== 'string' || !header) throw new Error('annotateSummary needs a header');
  const list = Array.isArray(blocks) ? blocks.map((block) => ({ ...block })) : [];
  const index = list.findIndex((block) => typeof block?.text === 'string');
  if (index >= 0) {
    list[index] = { ...list[index], text: `${header}\n${list[index].text}` };
    return list;
  }
  return [{ type: 'text', text: header }, ...list];
}

export default { SYSTEM_CONVENTION, LABEL, gistHeader, renderGistBlock, annotateSummary };
