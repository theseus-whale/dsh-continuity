export function verifyWatermark({ mode, checkpoint, backfillTurns = [], formalTurns = [], deltaTurns = [] }) {
  if (!['onfold-formal', 'delta-catchup'].includes(mode)) return { ok: false, errors: ['mode-required'] };
  const errors = [];
  const all = [...backfillTurns, ...formalTurns, ...deltaTurns];
  const byId = new Map();
  for (const turn of all) {
    if (byId.has(turn.turnId)) errors.push(`duplicate-turn:${turn.turnId}`);
    byId.set(turn.turnId, turn);
    if (turn.seqEnd > checkpoint && backfillTurns.includes(turn)) errors.push(`backfill-past-checkpoint:${turn.turnId}`);
  }
  if (mode === 'onfold-formal') {
    for (const turn of formalTurns) if (backfillTurns.some((row) => row.turnId === turn.turnId)) errors.push(`formal-overlaps-backfill:${turn.turnId}`);
  }
  if (mode === 'delta-catchup') {
    for (const turn of deltaTurns) if (backfillTurns.some((row) => row.turnId === turn.turnId)) errors.push(`delta-overlaps-backfill:${turn.turnId}`);
  }
  const ordered = [...backfillTurns, ...deltaTurns].sort((a, b) => a.seqStart - b.seqStart);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].seqStart <= ordered[i - 1].seqEnd) errors.push(`range-overlap:${ordered[i].turnId}`);
  }
  return { ok: errors.length === 0, errors };
}

export function activationBoundary({ mode, stagingSummaries = [], formalBefore = [], formalAfter = [] }) {
  const errors = [];
  if (mode === 'onfold-formal') {
    const after = new Map(formalAfter.map((row) => [row.turnId, row]));
    for (const row of formalBefore) {
      if (!after.has(row.turnId) || after.get(row.turnId).summarySha256 !== row.summarySha256) errors.push(`formal-overwritten:${row.turnId}`);
    }
  }
  for (const row of stagingSummaries) {
    if (formalBefore.some((existing) => existing.turnId === row.turnId && existing.summarySha256 !== row.summarySha256)) {
      errors.push(`activation-conflict:${row.turnId}`);
    }
  }
  return { ok: errors.length === 0, errors };
}
