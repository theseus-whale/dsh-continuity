import { eventText, userSourceKind } from './source-view.mjs';

/** Shared Host/legacy turn grouping for background archival and unified fold. */
export function groupTurnEvents(events) {
  const ordered = [...events].sort((a, b) => Number(a.seq) - Number(b.seq));
  const makeGroup = (inTurn, host = null) => {
    const allowed = inTurn.filter((event) => event.type === 'user/message'
      ? ['user', 'peer'].includes(userSourceKind(event))
      : ['assistant/message', 'tool/result'].includes(event.type));
    const users = allowed.filter((event) => event.type === 'user/message');
    if (users.length === 0 || !allowed.some((event) => eventText(event).trim())) return null;
    const start = Number(users[0].seq);
    return {
      turnId: `turn-${String(start).padStart(6, '0')}`,
      events: inTurn,
      allowed,
      start,
      end: Number(allowed.at(-1).seq),
      closed: host ? host.closed : true,
      turnEndSeq: host?.closed ? host.end : null,
      ...(host ? { hostStart: host.start, hostEnd: host.end } : {}),
    };
  };
  const hostRanges = [];
  let current = null;
  for (const event of ordered) {
    if (event?.type === 'turn/start') {
      if (current) { current.end = Number(event.seq) - 1; current.closed = true; }
      current = { start: Number(event.seq), end: Number(ordered.at(-1)?.seq ?? event.seq), closed: false };
      hostRanges.push(current);
    } else if (event?.type === 'turn/end' && current) {
      current.end = Number(event.seq);
      current.closed = true;
      current = null;
    }
  }
  if (hostRanges.length > 0) {
    return hostRanges.map((range) => makeGroup(ordered.filter((event) => Number(event.seq) >= range.start && Number(event.seq) <= range.end), range)).filter(Boolean);
  }
  const users = ordered.filter((event) => event?.type === 'user/message' && ['user', 'peer'].includes(userSourceKind(event)));
  return users.map((user, index) => {
    const start = Number(user.seq);
    const next = index + 1 < users.length ? Number(users[index + 1].seq) : Number(ordered.at(-1)?.seq ?? start) + 1;
    return makeGroup(ordered.filter((event) => Number(event.seq) >= start && Number(event.seq) < next));
  }).filter(Boolean);
}
