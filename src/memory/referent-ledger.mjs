/**
 * Term-to-referent ledger.
 *
 * An alias is a relation between a term and a stable referent, not merely a
 * repeated word. Same term with two referents is a new sense, not an alias.
 */
import { DEFAULT_ALIASES } from '../facets/schema.mjs';

const NIL_REFERENTS = new Set(['NIL', 'nil', 'unknown', '未知', '未知实体', 'null']);

function dominant(counts) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  return { value: entries[0][0], count: entries[0][1], total, ratio: entries[0][1] / total };
}

export class ReferentLedger {
  constructor({ minUser = 2, minEvents = 2, terms = new Map(), requireConfirmation = false } = {}) {
    this.minUser = minUser;
    this.minEvents = minEvents;
    this.terms = terms;
    this.requireConfirmation = requireConfirmation;
  }

  observe({ term, source = 'user', eventId, referent = null, role = null, target = null, nowTurn = 0, kind = 'mention', confirmed = false }) {
    const clean = String(term ?? '').trim();
    if (clean.length === 0) return { action: 'none', reason: 'no-term' };
    if (DEFAULT_ALIASES[clean] !== undefined) return { action: 'none', reason: 'known-alias' };

    const record = this.terms.get(clean) ?? {
      term: clean,
      user: 0,
      assistant: 0,
      events: new Set(),
      referents: {},
      roles: {},
      targets: {},
      firstSeen: nowTurn,
      lastSeen: nowTurn,
      strong: false,
      proposed: false,
      nilCount: 0,
      confirmed: false,
    };
    if (source === 'user' || source === 'coo' || source === 'peer') record.user += 1;
    else record.assistant += 1;
    record.events.add(eventId);
    if (confirmed) record.confirmed = true;
    if (referent !== null && NIL_REFERENTS.has(String(referent))) record.nilCount += 1;
    if (referent !== null && !NIL_REFERENTS.has(String(referent))) record.referents[referent] = (record.referents[referent] ?? 0) + 1;
    if (role !== null) record.roles[role] = (record.roles[role] ?? 0) + 1;
    if (target !== null) record.targets[target] = (record.targets[target] ?? 0) + 1;
    if (kind === 'definition' || kind === 'quoted') record.strong = true;
    record.lastSeen = nowTurn;
    this.terms.set(clean, record);

    if (record.proposed) return { action: 'none', reason: 'already-proposed', record };
    if (record.user < this.minUser) return { action: 'none', reason: 'need-user-repeat', record };
    if (record.events.size < this.minEvents) return { action: 'none', reason: 'need-event-repeat', record };
    if (Object.keys(record.referents).length === 0 && record.nilCount > 0) {
      return { action: 'none', reason: 'nil-referent', record };
    }

    const dominantRole = dominant(record.roles);
    if (dominantRole !== null && dominantRole.ratio < 0.8) return { action: 'none', reason: 'role-unstable', record };
    const dominantReferent = dominant(record.referents);
    if (dominantReferent === null) return { action: 'none', reason: 'no-referent', record };
    if (dominantReferent.ratio < 0.8) return { action: 'none', reason: 'referent-unstable', record };
    const dominantTarget = dominant(record.targets);
    if (dominantTarget === null) return { action: 'none', reason: 'no-target-facet', record };
    if (this.requireConfirmation && !record.confirmed) return { action: 'none', reason: 'unconfirmed', record };

    record.proposed = true;
    return {
      action: 'propose',
      reason: 'cross-event-referent',
      term: clean,
      referent: dominantReferent.value,
      role: dominantRole?.value ?? null,
      target: dominantTarget.value,
      text: `[新别名?] ${clean} → ${dominantTarget.value}（referent ${dominantReferent.value}）`,
      record,
    };
  }
}
