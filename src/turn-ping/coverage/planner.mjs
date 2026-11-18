const summaryMatches = (summary, turn, sessionId, cutoff = null) => Boolean(
  summary
  && summary.turnId === turn.turnId
  && typeof summary.sessionId === 'string'
  && (summary.sessionId === sessionId || summary.sessionId === turn.sessionId)
  && typeof summary.rawTextSha256 === 'string'
  && summary.rawTextSha256 === turn.rawTextSha256
  && typeof summary.summarySha256 === 'string'
  && Number.isInteger(summary.availableCutoff)
  && summary.availableCutoff <= (cutoff ?? turn.availableCutoff ?? summary.availableCutoff),
);
const vectorMatches = (vector, summary, turn, indexVersion) => Boolean(
  vector
  && vector.turnId === turn.turnId
  && vector.summarySha256 === summary.summarySha256
  && (!indexVersion || vector.vectorIndexVersion === indexVersion),
);

export function planCoverage({ audit, formalSummaries = [], formalVectors = [], stagedSummaries = [], stagedVectors = [], indexVersion = null, sessionId = null }) {
  const summaryByTurn = new Map([...formalSummaries, ...stagedSummaries].map((row) => [row.turnId, row]));
  const vectorByTurn = new Map([...formalVectors, ...stagedVectors].map((row) => [row.turnId, row]));
  const items = [];
  for (const turn of audit.eligible) {
    const summary = summaryByTurn.get(turn.turnId);
    if (!summaryMatches(summary, turn, sessionId ?? audit.sessionId, audit.checkpoint ?? null)) {
      items.push({ kind: 'summary', turn, reason: summary ? 'summary-identity-mismatch' : 'missing-summary' });
      continue;
    }
    const vector = vectorByTurn.get(turn.turnId);
    if (!vectorMatches(vector, summary, turn, indexVersion)) {
      items.push({ kind: 'vector', turn, summary, reason: vector ? 'vector-identity-mismatch' : 'missing-vector' });
      continue;
    }
    items.push({ kind: 'covered', turn, summary });
  }
  for (const turn of audit.hold) items.push({ kind: 'hold', turn, reason: turn.reason ?? 'hold' });
  const summaryJobs = items.filter((item) => item.kind === 'summary').length;
  const vectorJobs = items.filter((item) => item.kind === 'vector').length;
  return {
    kind: 'coverage-plan',
    indexVersion,
    items,
    pending: summaryJobs + vectorJobs,
    summaryJobs,
    vectorJobs,
    hold: audit.hold.length,
    ready: summaryJobs + vectorJobs === 0,
  };
}
