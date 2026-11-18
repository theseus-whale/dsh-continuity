import { auditBackfill } from '../backfill/audit.mjs';

/**
 * Generic per-session coverage audit. No session id is special-cased.
 * `writeOrigin` distinguishes legacy initial backfill from incremental gaps.
 */
export function auditCoverage({ sessionId, events = [], turns = null, checkpoint, activeTailStartSeq, foldedSeqs = null, writeOrigin = 'legacy-backfill', unprovableTurnIds = [] }) {
  const base = auditBackfill({ sessionId, events, turns, checkpoint, activeTailStartSeq, foldedSeqs });
  const unprovable = new Set(unprovableTurnIds);
  const map = (row, foldedVerified) => ({
    ...row,
    sessionId,
    writeOrigin,
    backfillId: null,
    foldVerified: foldedVerified,
    firstFoldSeq: row.firstFoldSeq ?? null,
    status: foldedVerified ? 'complete' : 'legacy-complete',
    reason: foldedVerified ? null : 'first-fold-unknown; active-tail departure proven',
  });
  const provenEligible = base.hold
    .filter((row) => row.seqEnd < activeTailStartSeq && row.seqEnd <= checkpoint && !unprovable.has(row.turnId))
    .map((row) => map(row, false));
  const held = base.hold
    .filter((row) => !provenEligible.some((candidate) => candidate.turnId === row.turnId))
    .map((row) => ({
      ...map(row, false),
      status: 'HOLD',
      reason: unprovable.has(row.turnId) ? 'raw-or-range-unprovable' : 'active-tail-or-range-unprovable',
    }));
  const eligible = [...base.eligible.map((row) => map(row, true)), ...provenEligible];
  return {
    ...base,
    eligible,
    hold: held,
    counts: { ...base.counts, eligible: eligible.length, hold: held.length, writeOrigin },
  };
}
