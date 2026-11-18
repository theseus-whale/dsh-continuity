/**
 * Adapters around the existing dsh-continuity surface. They do not create a
 * second fold engine: the caller supplies fold events and raw turn records.
 */
export function foldFromContinuity(record) {
  const from = Number(record?.from);
  const to = Number(record?.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) throw new Error('adapter: invalid fold range');
  return {
    compactionId: record?.compactionId ?? null,
    from,
    to,
    gistSeq: Number.isInteger(record?.gistSeq) ? record.gistSeq : null,
    cutoff: Number.isInteger(record?.cutoff) ? record.cutoff : to,
    // dsh-continuity folds.json has no shadowedSeqs; the host compaction event must provide them.
    shadowedSeqs: Array.isArray(record?.shadowedSeqs) ? record.shadowedSeqs : null,
  };
}

export function turnFromDirectory(row) {
  return {
    turnId: row.turnId,
    seqStart: Number(row.seqStart),
    seqEnd: Number(row.seqEnd),
    rawTextSha256: row.rawTextSha256,
    boundarySeqs: Array.isArray(row.boundarySeqs) ? row.boundarySeqs : [Number(row.seqStart), Number(row.seqEnd)],
  };
}

export function readbackTurns(rows) {
  return rows.map((row) => ({ turnId: row.turnId, seqStart: Number(row.seqStart), seqEnd: Number(row.seqEnd), text: row.text ?? '' }));
}
