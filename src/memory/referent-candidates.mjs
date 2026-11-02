/**
 * Referent candidate generation.
 * Deterministic evidence: known aliases, exact term occurrences, retrieval hits.
 * A candidate is not a promotion; it is input to the referent ledger.
 */
import { DEFAULT_ALIASES } from '../facets/schema.mjs';

export function candidateReferents({
  term,
  records = [],
  keywordHits = [],
  semanticHits = [],
  max = 5,
} = {}) {
  const clean = String(term ?? '').trim();
  const candidates = new Map();
  const add = (referent, target, source, score, role = null, turn = null) => {
    const existing = candidates.get(referent);
    if (existing === undefined || score > existing.score) {
      candidates.set(referent, { referent, target, source, score, role, turn });
    }
  };

  if (DEFAULT_ALIASES[clean] !== undefined) {
    const alias = DEFAULT_ALIASES[clean];
    add(`facet:${alias.activity ?? alias.topic}`, alias.activity ?? alias.topic, 'alias', 1, 'alias');
  }

  for (const record of records) {
    if (!String(record.text ?? '').includes(clean)) continue;
    add(`turn:${record.turn}`, record.facets?.activity ?? null, 'event-log', 0.8, 'mention', record.turn);
  }

  const hitRank = new Map();
  [...keywordHits, ...semanticHits].forEach((hit, index) => {
    const previous = hitRank.get(hit.turn);
    if (previous === undefined) hitRank.set(hit.turn, index);
    else hitRank.set(hit.turn, Math.min(previous, index));
  });
  for (const [turn, rank] of hitRank) {
    const record = records.find((item) => item.turn === turn);
    if (record === undefined) continue;
    add(`turn:${turn}`, record.facets?.activity ?? null, 'retrieval', 0.5 / (rank + 1), 'retrieval', turn);
  }

  return [...candidates.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}

export function bindReferent(candidates, { threshold = 0.5 } = {}) {
  const top = candidates[0] ?? null;
  if (top === null || top.score < threshold) return { referent: 'NIL', candidate: top, reason: 'below-threshold' };
  return { referent: top.referent, candidate: top, reason: 'bound' };
}
