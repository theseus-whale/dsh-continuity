import { sha256 } from './config.mjs';

export function clipHeadTail(text, cap) {
  if (typeof text !== 'string' || text.length <= cap) return { text: text ?? '', clipped: false, originalChars: text?.length ?? 0 };
  const marker = `\n…[clipped ${text.length - cap} chars]…\n`;
  const available = Math.max(0, cap - marker.length);
  const head = Math.floor(available * 0.6);
  const tail = available - head;
  return { text: text.slice(0, head) + marker + text.slice(text.length - tail), clipped: true, originalChars: text.length };
}

export function eventText(event) {
  const data = event?.data ?? {};
  const content = data.message?.content ?? data.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((block) => typeof block?.text === 'string').map((block) => block.text).join('\n');
  return typeof data.text === 'string' ? data.text : '';
}

export const userSourceKind = (event) => event?.data?.message?.source?.kind ?? event?.data?.source?.kind ?? null;

/**
 * Structural whitelist. Only user/peer user messages, assistant messages and
 * real tool results survive; all other user-role runtime projections are excluded.
 */
export function buildSourceView(events, config) {
  const caps = config.sourceView;
  const blocks = [];
  const excluded = [];
  let individuallyClipped = 0;
  for (const event of events) {
    const kind = userSourceKind(event);
    if (event?.type === 'user/message') {
      if (!caps.userSourceKinds.includes(kind)) { excluded.push({ type: event.type, sourceKind: kind }); continue; }
    } else if (event?.type === 'assistant/message') {
      // retained unless it is an old summary/checkpoint type, which is not this event type
    } else if (event?.type === 'tool/result') {
      // retained verbatim, including historical quotations
    } else {
      excluded.push({ type: event?.type ?? 'unknown' });
      continue;
    }
    const raw = eventText(event);
    if (!raw.trim()) continue;
    const cap = event.type === 'user/message' ? caps.userChars : event.type === 'assistant/message' ? caps.assistantChars : caps.toolChars;
    const clipped = clipHeadTail(raw, cap);
    if (clipped.clipped) individuallyClipped += 1;
    blocks.push(`[${event.type} | seq=${event.seq}]\n${clipped.text}`);
  }
  let text = blocks.join('\n\n');
  let globalClipped = false;
  if (text.length > caps.totalChars) {
    text = clipHeadTail(text, caps.totalChars).text;
    globalClipped = true;
  }
  return {
    text,
    sourceViewSha256: sha256(text),
    chars: text.length,
    clipped: individuallyClipped > 0 || globalClipped,
    individuallyClipped,
    globalClipped,
    excluded,
  };
}
