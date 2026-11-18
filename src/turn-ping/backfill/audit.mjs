import { buildTurnsFromEvents } from '../host.mjs';

/**
 * Read-only range audit. It never writes summaries or calls a provider.
 * Unknown first-fold history is represented as legacy-backfill/null, never guessed.
 */
export function auditBackfill({ sessionId, events = [], turns = null, checkpoint, activeTailStartSeq, foldedSeqs = null }) {
  if (!Number.isInteger(checkpoint)) throw new Error('auditBackfill: integer checkpoint required');
  if (!Number.isInteger(activeTailStartSeq)) throw new Error('auditBackfill: integer activeTailStartSeq required');
  const turnList = turns ?? buildTurnsFromEvents(sessionId, events);
  const folded = foldedSeqs instanceof Set ? foldedSeqs : new Set(foldedSeqs ?? []);
  const eligible = [];
  const hold = [];
  const missing = [];
  let excludedActiveTail = 0;
  for (const turn of turnList) {
    if (turn.seqEnd >= activeTailStartSeq) { excludedActiveTail += 1; continue; }
    if (turn.seqEnd > checkpoint) { excludedActiveTail += 1; continue; }
    const boundaries = Array.isArray(turn.boundarySeqs) && turn.boundarySeqs.length > 0 ? turn.boundarySeqs : [turn.seqStart, turn.seqEnd];
    const complete = boundaries.every((seq) => folded.has(seq));
    const record = {
      ...turn,
      writeOrigin: 'legacy-backfill',
      backfillId: null,
      firstFoldSeq: turn.firstFoldSeq ?? null,
      availableCutoff: checkpoint,
      status: complete ? 'complete' : 'HOLD',
      reason: complete ? null : 'fold-unverified-or-partial',
    };
    if (complete) eligible.push(record); else hold.push(record);
  }
  return {
    kind: 'turn-ping-backfill-audit',
    sessionId,
    checkpoint,
    activeTailStartSeq,
    excludedActiveTail,
    eligible,
    hold,
    missing,
    counts: { turns: turnList.length, eligible: eligible.length, hold: hold.length, missing: missing.length, activeTailExcluded: excludedActiveTail },
    pending: eligible.length,
  };
}
