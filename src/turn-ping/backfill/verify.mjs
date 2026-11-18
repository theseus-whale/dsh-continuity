import { createHash } from 'node:crypto';

const sha = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

export function verifyBackfill({ audit, staging, formalSummaries = [], formalVectors = [], rawTextBefore = null, rawTextAfter = null, activeTailStartSeq = null }) {
  const errors = [];
  const summaries = staging ? null : [];
  return (async () => {
    const stagedSummaries = await staging.summaries();
    const stagedVectors = await staging.vectors();
    const summaryById = new Map(stagedSummaries.map((row) => [row.turnId, row]));
    const duplicateSummaries = stagedSummaries.length - new Set(stagedSummaries.map((row) => row.turnId)).size;
    if (duplicateSummaries !== 0) errors.push(`duplicate-summaries:${duplicateSummaries}`);
    if (stagedVectors.length !== new Set(stagedVectors.map((row) => row.turnId)).size) errors.push('duplicate-vectors');
    for (const vector of stagedVectors) {
      const summary = summaryById.get(vector.turnId);
      if (!summary) errors.push(`orphan-vector:${vector.turnId}`);
      else if (summary.summarySha256 !== vector.summarySha256) errors.push(`summary-vector-sha-mismatch:${vector.turnId}`);
    }
    for (const summary of stagedSummaries) {
      if (!summary.rawTextSha256 || !summary.summarySha256) errors.push(`summary-binding-missing:${summary.turnId}`);
      if (summary.writeOrigin !== 'legacy-backfill') errors.push(`writeOrigin-invalid:${summary.turnId}`);
      if (summary.firstFoldSeq !== null) errors.push(`firstFoldSeq-not-unknown:${summary.turnId}`);
      if (activeTailStartSeq !== null && summary.seqEnd >= activeTailStartSeq) errors.push(`active-tail-written:${summary.turnId}`);
    }
    const pending = audit.eligible.filter((turn) => !summaryById.has(turn.turnId)).length;
    if (pending !== 0) errors.push(`pending:${pending}`);
    if (rawTextBefore !== null && rawTextAfter !== null && sha(rawTextBefore) !== sha(rawTextAfter)) errors.push('raw-sha-changed');
    for (const vector of formalVectors) {
      if (!formalSummaries.some((summary) => summary.turnId === vector.turnId && summary.summarySha256 === vector.summarySha256)) {
        errors.push(`formal-orphan-vector:${vector.turnId}`);
      }
    }
    return { ok: errors.length === 0, errors, pending, stagedSummaries: stagedSummaries.length, stagedVectors: stagedVectors.length, duplicateSummaries, activeTailWritten: errors.some((error) => error.startsWith('active-tail-written')) };
  })();
}
