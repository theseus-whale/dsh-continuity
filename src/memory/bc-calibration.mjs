/**
 * Make B scores comparable without pretending raw cosine is a probability.
 *
 * - `centeredScores`: per-turn score minus that turn's mean A score
 * - `conceptCenteredScores`: per-turn score minus that concept's history mean
 * - `scoreMargin`: top1 - top2 (the practical "is this label distinct?" signal)
 * - `labelRanks`: 1-based rank per label
 */
export function calibrateRecords(records = []) {
  const scoresOf = (row) => row?.conceptScores && typeof row.conceptScores === 'object'
    ? Object.entries(row.conceptScores).filter(([, value]) => Number.isFinite(Number(value)))
    : [];
  const conceptSums = new Map();
  const conceptCounts = new Map();
  for (const row of records) {
    for (const [label, value] of scoresOf(row)) {
      conceptSums.set(label, (conceptSums.get(label) ?? 0) + Number(value));
      conceptCounts.set(label, (conceptCounts.get(label) ?? 0) + 1);
    }
  }
  const conceptMeans = new Map([...conceptSums].map(([label, sum]) => [label, sum / Math.max(1, conceptCounts.get(label) ?? 1)]));

  for (const row of records) {
    const scores = scoresOf(row);
    if (scores.length === 0) {
      row.centeredScores = {};
      row.conceptCenteredScores = {};
      row.scoreMargin = 0;
      row.topScore = 0;
      row.labelRanks = {};
      row.labelState = 'unlabeled';
      continue;
    }
    const mean = scores.reduce((sum, [, value]) => sum + Number(value), 0) / scores.length;
    const sorted = [...scores].sort((a, b) => Number(b[1]) - Number(a[1]));
    row.centeredScores = Object.fromEntries(scores.map(([label, value]) => [label, Number((Number(value) - mean).toFixed(6))]));
    row.conceptCenteredScores = Object.fromEntries(scores.map(([label, value]) => [label, Number((Number(value) - (conceptMeans.get(label) ?? mean)).toFixed(6))]));
    row.scoreMargin = Number((Number(sorted[0]?.[1] ?? 0) - Number(sorted[1]?.[1] ?? 0)).toFixed(6));
    row.topScore = Number(Number(sorted[0]?.[1] ?? 0).toFixed(6));
    row.labelRanks = Object.fromEntries(sorted.map(([label], index) => [label, index + 1]));
    row.labelState = row.topScore < 0.3
      ? 'unlabeled'
      : (row.scoreMargin < 0.03 || row.topScore < 0.4 ? 'uncertain' : 'labeled');
  }
  return records;
}
