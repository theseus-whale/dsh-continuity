/**
 * Confidence calibration utilities for the local facet head.
 * Labels here are weak T-derived labels, so this is provisional calibration,
 * not human-gold calibration.
 */

export function reliabilityBins(points, { bins = 10 } = {}) {
  const buckets = Array.from({ length: bins }, (_, index) => ({
    lower: index / bins,
    upper: (index + 1) / bins,
    count: 0,
    confidenceSum: 0,
    correct: 0,
  }));
  for (const point of points) {
    const confidence = Math.max(0, Math.min(1, point.confidence));
    const index = Math.min(bins - 1, Math.floor(confidence * bins));
    const bucket = buckets[index];
    bucket.count += 1;
    bucket.confidenceSum += confidence;
    bucket.correct += point.correct ? 1 : 0;
  }
  return buckets.map((bucket) => ({
    lower: bucket.lower,
    upper: bucket.upper,
    count: bucket.count,
    confidence: bucket.count === 0 ? 0 : bucket.confidenceSum / bucket.count,
    accuracy: bucket.count === 0 ? 0 : bucket.correct / bucket.count,
  }));
}

export function thresholdCurve(points, { steps = 20 } = {}) {
  const curve = [];
  for (let index = 1; index <= steps; index += 1) {
    const threshold = index / steps;
    const accepted = points.filter((point) => point.confidence >= threshold);
    const correct = accepted.filter((point) => point.correct).length;
    curve.push({
      threshold,
      coverage: points.length === 0 ? 0 : accepted.length / points.length,
      precision: accepted.length === 0 ? 0 : correct / accepted.length,
      accepted: accepted.length,
    });
  }
  return curve;
}

export function chooseThreshold(points, { targetPrecision = 0.9, minCoverage = 0.1 } = {}) {
  const curve = thresholdCurve(points);
  const eligible = curve
    .filter((item) => item.precision >= targetPrecision && item.coverage >= minCoverage)
    .sort((a, b) => b.coverage - a.coverage);
  return eligible[0] ?? null;
}
