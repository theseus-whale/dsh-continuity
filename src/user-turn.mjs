/**
 * Only real user input may be quoted as "what the user just said".
 * runtime-context, time-context, delivery notices and queue splices are not
 * statements by the person, even though they travel as user/message envelopes.
 */
import { eventText } from './session-log.mjs';

export function messageSourceKind(event) {
  const data = event?.data;
  return data?.message?.source?.kind ?? data?.source?.kind ?? null;
}

/** Latest surface text from a real source.kind === "user" message. */
export function latestUserTurnFromSession(session) {
  const nodes = session?.surface?.nodes ?? [];
  for (let i = nodes.length - 1; i >= 0; i--) {
    let event;
    try { event = session.eventAt(nodes[i]); } catch { continue; }
    let text = '';
    if (event?.type === 'agent/inbox/spliced') {
      const inserted = Array.isArray(event?.data?.inserted) ? event.data.inserted : [];
      text = inserted
        .filter((item) => item?.source?.kind === 'user')
        .map((item) => (Array.isArray(item?.content) ? item.content : []).map((part) => part?.text ?? '').join(' '))
        .join(' ')
        .trim();
    } else if (event?.type === 'user/message') {
      if (messageSourceKind(event) !== 'user') continue;
      try { text = eventText(event, { includeReasoning: false }).trim(); } catch { continue; }
    } else {
      continue;
    }
    if (!text) continue;
    if (/^\[(线|标签|习惯|技能|归位)\]/.test(text)) continue;
    if (/^\s*</.test(text) || text.includes('system-reminder')) continue;
    return { seq: nodes[i], text };
  }
  return null;
}
