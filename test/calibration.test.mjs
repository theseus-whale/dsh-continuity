import assert from 'node:assert/strict';
import test from 'node:test';
import { reliabilityBins, thresholdCurve, chooseThreshold } from '../src/memory/calibration.mjs';

test('reliability bins separate confident and uncertain points', () => {
  const bins = reliabilityBins([
    { confidence: 0.9, correct: true },
    { confidence: 0.9, correct: true },
    { confidence: 0.2, correct: false },
  ], { bins: 10 });
  assert.equal(bins[9].count, 2);
  assert.equal(bins[9].accuracy, 1);
  assert.equal(bins[2].count, 1);
  assert.equal(bins[2].accuracy, 0);
});

test('threshold curve and chooser select a high-precision cut', () => {
  const points = [
    { confidence: 0.9, correct: true },
    { confidence: 0.8, correct: true },
    { confidence: 0.55, correct: false },
    { confidence: 0.2, correct: false },
  ];
  const curve = thresholdCurve(points);
  assert.ok(curve.some((item) => item.threshold === 0.5 && item.coverage === 0.75));
  const chosen = chooseThreshold(points, { targetPrecision: 0.9, minCoverage: 0.1 });
  assert.equal(chosen.threshold, 0.6);
  assert.equal(chosen.coverage, 0.5);
});
