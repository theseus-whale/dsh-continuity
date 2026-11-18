import { createHash } from 'node:crypto';

const sha = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

export async function verifyCoverage({ audit, plan, staging, formalSummaries = [], formalVectors = [], rawTextBefore = null, rawTextAfter = null, activeTailStartSeq = null }) {
  const errors = [];
  const stagedSummaries = staging ? await staging.summaries() : [];
  const stagedVectors = staging ? await staging.vectors() : [];
  const allSummaries = [...formalSummaries, ...stagedSummaries];
  const summaryByTurn = new Map(allSummaries.map((row) => [row.turnId, row]));
  const vectorByTurn = new Map([...formalVectors, ...stagedVectors].map((row) => [row.turnId, row]));
  const duplicateSummaries = allSummaries.length - new Set(allSummaries.map((row) => row.turnId)).size;
  if (duplicateSummaries !== 0) errors.push(`duplicate-summaries:${duplicateSummaries}`);
  for (const row of [...formalVectors, ...stagedVectors]) {
    const summary = summaryByTurn.get(row.turnId);
    if (!summary) errors.push(`orphan-vector:${row.turnId}`);
    else if (summary.summarySha256 !== row.summarySha256) errors.push(`summary-vector-mismatch:${row.turnId}`);
  }
  const pending = plan?.pending ?? 0;
  if (pending !== 0) errors.push(`pending:${pending}`);
  for (const turn of audit?.eligible ?? []) {
    if (!summaryByTurn.has(turn.turnId)) errors.push(`eligible-missing-summary:${turn.turnId}`);
    if (!vectorByTurn.has(turn.turnId)) errors.push(`eligible-missing-vector:${turn.turnId}`);
    if (activeTailStartSeq !== null && turn.seqEnd >= activeTailStartSeq) errors.push(`active-tail-eligible:${turn.turnId}`);
  }
  if (rawTextBefore !== null && rawTextAfter !== null && sha(rawTextBefore) !== sha(rawTextAfter)) errors.push('raw-sha-changed');
  return {
    ok: errors.length === 0,
    errors,
    pending,
    summaries: allSummaries.length,
    vectors: formalVectors.length + stagedVectors.length,
    holds: audit?.hold?.length ?? 0,
    activeTailWritten: errors.some((error) => error.startsWith('active-tail')),
    duplicateSummaries,
  };
}
