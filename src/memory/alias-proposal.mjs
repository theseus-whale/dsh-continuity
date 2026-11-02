/**
 * Alias-candidate state: watch new terms, propose an alias only after repeated
 * use, never on the first mention, and never for an existing alias.
 */
import { DEFAULT_ALIASES } from '../facets/schema.mjs';

export class AliasProposalState {
  constructor({ threshold = 2, cooldownTurns = 10, counts = new Map(), proposed = new Set(), lastProposalTurn = null } = {}) {
    this.threshold = threshold;
    this.cooldownTurns = cooldownTurns;
    this.counts = counts;
    this.proposed = proposed;
    this.lastProposalTurn = lastProposalTurn;
  }

  observe({ term, facets = {}, nowTurn = 0 }) {
    const clean = String(term ?? '').trim();
    if (clean.length === 0) return { action: 'none', reason: 'no-term' };
    if (DEFAULT_ALIASES[clean] !== undefined) return { action: 'none', reason: 'known-alias' };
    const count = (this.counts.get(clean) ?? 0) + 1;
    this.counts.set(clean, count);
    if (count < this.threshold) return { action: 'none', reason: 'need-repeat', count };
    if (this.proposed.has(clean)) return { action: 'none', reason: 'already-proposed', count };
    if (this.lastProposalTurn !== null && nowTurn - this.lastProposalTurn < this.cooldownTurns) {
      return { action: 'none', reason: 'cooldown', count };
    }
    const target = facets.activity ?? facets.topic ?? null;
    if (target === null) return { action: 'none', reason: 'no-target', count };
    this.proposed.add(clean);
    this.lastProposalTurn = nowTurn;
    return {
      action: 'propose',
      reason: 'proposed',
      term: clean,
      target,
      text: `[新别名?] ${clean} → ${target}`,
      count,
    };
  }
}
