/**
 * Event-bound alias ledger.
 *
 * A term becomes an alias only when:
 *   - it is not already a known alias
 *   - the user/Coo has used it at least twice
 *   - it appears in at least two distinct events
 *   - its role is stable
 *   - it maps to an existing facet
 *
 * Assistant-only mentions never promote. If no target facet exists, the term
 * is an accommodation candidate (new concept), not an alias.
 */
import { DEFAULT_ALIASES } from '../facets/schema.mjs';

function pickDominant(counts) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  return { value: entries[0][0], count: entries[0][1], total, ratio: entries[0][1] / total };
}

export class EventAliasLedger {
  constructor({ minUser = 2, minEvents = 2, terms = new Map() } = {}) {
    this.minUser = minUser;
    this.minEvents = minEvents;
    this.terms = terms;
  }

  observe({ term, source = 'user', eventId, role = null, target = null, nowTurn = 0, kind = 'mention' }) {
    const clean = String(term ?? '').trim();
    if (clean.length === 0) return { action: 'none', reason: 'no-term' };
    if (DEFAULT_ALIASES[clean] !== undefined) return { action: 'none', reason: 'known-alias' };

    const record = this.terms.get(clean) ?? {
      term: clean,
      user: 0,
      assistant: 0,
      events: new Set(),
      roles: {},
      targets: {},
      firstSeen: nowTurn,
      lastSeen: nowTurn,
      strong: false,
      proposed: false,
      accommodated: false,
    };
    if (source === 'user' || (source === 'coo' || source === 'peer')) record.user += 1;
    else record.assistant += 1;
    record.events.add(eventId);
    if (role !== null) record.roles[role] = (record.roles[role] ?? 0) + 1;
    if (target !== null) record.targets[target] = (record.targets[target] ?? 0) + 1;
    if (kind === 'definition' || kind === 'quoted') record.strong = true;
    record.lastSeen = nowTurn;
    this.terms.set(clean, record);

    if (record.proposed) return { action: 'none', reason: 'already-proposed', record };
    if (record.accommodated) return { action: 'none', reason: 'already-accommodated', record };
    if (record.user < this.minUser) return { action: 'none', reason: 'need-user-repeat', record };
    if (record.events.size < this.minEvents) return { action: 'none', reason: 'need-event-repeat', record };

    const dominantRole = pickDominant(record.roles);
    if (dominantRole !== null && dominantRole.ratio < 0.8) return { action: 'none', reason: 'role-unstable', record };
    const dominantTarget = pickDominant(record.targets);
    if (dominantTarget === null) {
      record.accommodated = true;
      return {
        action: 'accommodate',
        reason: 'no-target-facet',
        term: clean,
        text: `[新概念?] ${clean}（暂无 facet 归属）`,
        record,
      };
    }

    record.proposed = true;
    return {
      action: 'propose',
      reason: 'cross-event-assimilation',
      term: clean,
      role: dominantRole?.value ?? null,
      target: dominantTarget.value,
      text: `[新别名?] ${clean} → ${dominantTarget.value}`,
      record,
    };
  }
}
