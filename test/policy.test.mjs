import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CACHE_FIRST_POLICY,
  CACHE_GRADUAL_POLICY,
  DEFAULT_POLICY,
  calibrateProtect,
  planFold,
  resolvePolicy,
  shouldWait,
} from '../src/policy.mjs';

const W = 800000;

test('defaults resolve to a frozen policy', () => {
  const p = resolvePolicy();
  assert.equal(p.setpoint, DEFAULT_POLICY.setpoint);
  assert.ok(Object.isFrozen(p));
});

test('the cache-first default has no proportional zone', () => {
  assert.equal(CACHE_FIRST_POLICY.setpoint, CACHE_FIRST_POLICY.high);
  assert.equal(DEFAULT_POLICY, CACHE_FIRST_POLICY);
  assert.ok(CACHE_GRADUAL_POLICY.setpoint < CACHE_GRADUAL_POLICY.high);
});

test('unknown keys and inverted bands are rejected', () => {
  assert.throws(() => resolvePolicy({ nope: 1 }), /unknown policy key/);
  assert.throws(() => resolvePolicy({ low: 0.9, setpoint: 0.65, high: 0.8 }), /low < high/);
  assert.throws(() => resolvePolicy({ emergencyTo: 0.99 }), /emergencyTo/);
});

test('below setpoint is a no-op', () => {
  const r = planFold({ estTokens: 0.5 * W, windowTokens: W });
  assert.equal(r.budget, 0);
  assert.equal(r.reason, 'below-setpoint');
});

test('cache-first: 59% and exactly 60% are below the setpoint', () => {
  for (const ratio of [0.59, 0.60]) {
    const r = planFold({ estTokens: ratio * W, windowTokens: W });
    assert.equal(r.budget, 0);
    assert.equal(r.reason, 'below-setpoint');
  }
});

test('cache-first: a high crossing drains to low', () => {
  const r = planFold({ estTokens: 0.62 * W, windowTokens: W });
  assert.equal(r.reason, 'band-high');
  assert.equal(r.target, CACHE_FIRST_POLICY.low * W);
  assert.ok(Math.abs(r.budget - (0.62 - CACHE_FIRST_POLICY.low) * W) < 1e-6);
});

test('gradual: inside the proportional zone the deadband withholds small passes', () => {
  const r = planFold({ estTokens: 0.54 * W, windowTokens: W, policy: CACHE_GRADUAL_POLICY });
  assert.equal(r.budget, 0);
  assert.equal(r.reason, 'deadband');
  assert.equal(shouldWait({ estTokens: 0.54 * W, windowTokens: W, policy: CACHE_GRADUAL_POLICY }), true);
});

test('gradual: proportional pass starts at minAction', () => {
  const r = planFold({ estTokens: 0.58 * W, windowTokens: W, policy: CACHE_GRADUAL_POLICY });
  assert.equal(r.reason, 'setpoint');
  assert.ok(r.budget >= CACHE_GRADUAL_POLICY.minAction);
  assert.ok(Math.abs(r.budget - 25600) < 1e-6);
});

test('above high it drains to low', () => {
  const r = planFold({ estTokens: 0.62 * W, windowTokens: W });
  assert.equal(r.reason, 'band-high');
  assert.equal(r.target, CACHE_FIRST_POLICY.low * W);
  assert.ok(r.budget < DEFAULT_POLICY.maxPerBatch);
});

test('exactly 65% is still band-high, capped at 190k', () => {
  const r = planFold({ estTokens: CACHE_FIRST_POLICY.emergency * W, windowTokens: W });
  assert.equal(r.reason, 'band-high');
  assert.equal(r.target, CACHE_FIRST_POLICY.low * W);
  assert.equal(r.budget, CACHE_FIRST_POLICY.maxPerBatch);
});

test('emergency drains below high so it cannot chain into band-high', () => {
  assert.equal(CACHE_FIRST_POLICY.emergencyTo, 0.42);
  const r = planFold({ estTokens: 0.66 * W, windowTokens: W });
  assert.equal(r.reason, 'emergency');
  assert.ok(Math.abs(r.budget - 0.24 * W) < 1e-6);
  const after = 0.66 * W - r.budget;
  assert.ok(Math.abs(after - 0.42 * W) < 1e-6);
  // A 5% margin is the operational meaning of "the next batch does not
  // immediately go band-high".
  assert.ok(after <= (CACHE_FIRST_POLICY.high - 0.05) * W);
});

test('emergency drains to emergencyTo and ignores the per-pass cap', () => {
  const r = planFold({ estTokens: 0.70 * W, windowTokens: W });
  assert.equal(r.reason, 'emergency');
  assert.ok(Math.abs(r.budget - 0.28 * W) < 1e-6);
  const smallCap = resolvePolicy({ maxPerBatch: 1000 });
  const e = planFold({ estTokens: 0.70 * W, windowTokens: W, policy: smallCap });
  assert.equal(e.reason, 'emergency');
  assert.ok(Math.abs(e.budget - 0.28 * W) < 1e-6);
  assert.ok(e.budget > smallCap.maxPerBatch);
});

test('the protected recent window is never folded', () => {
  const policy = resolvePolicy({ protect: 0.99 });
  const r = planFold({ estTokens: 0.90 * W, windowTokens: W, policy });
  assert.equal(r.budget, 0);
  assert.equal(r.reason, 'protected');
});

test('invalid measurements are a no-op, not a throw', () => {
  assert.equal(planFold({ estTokens: NaN, windowTokens: W }).reason, 'invalid');
  assert.equal(planFold({ estTokens: 1, windowTokens: 0 }).reason, 'invalid');
});

test('token-saver continuity band starts earlier and lowers the floor', () => {
  const policy = resolvePolicy({
    setpoint: 0.455,
    high: 0.455,
    low: 0.34,
    emergency: 0.56,
    emergencyTo: 0.36,
    protect: 0.19,
    maxPerBatch: 140000,
    minAction: 16000,
  });
  const measuredWindow = 792576;
  const measured = 363543;
  const r = planFold({ estTokens: measured, windowTokens: measuredWindow, policy });
  assert.equal(r.reason, 'band-high');
  assert.ok(r.budget > 0);
  assert.ok(measured - r.budget <= 0.34 * measuredWindow + 1000);
  const oldFloor = 0.30 * measuredWindow + 117816;
  const newFloor = 0.19 * measuredWindow + 117816;
  assert.ok(newFloor < oldFloor);
});

test('balanced 0.48/0.32 band folds less often without raising the mean', () => {
  const policy = resolvePolicy({
    setpoint: 0.48,
    high: 0.48,
    low: 0.32,
    emergency: 0.65,
    emergencyTo: 0.42,
    protect: 0.14,
    maxPerBatch: 190000,
    minAction: 24000,
  });
  const measuredWindow = 792576;
  const high = 0.48 * measuredWindow;
  const low = 0.32 * measuredWindow;
  assert.ok(0.14 * measuredWindow + 133272 < low);
  assert.ok(high - low < policy.maxPerBatch);
  assert.ok((0.65 - 0.42) * measuredWindow > 140000);
  const below = planFold({ estTokens: high - 1, windowTokens: measuredWindow, policy });
  assert.equal(below.reason, 'below-setpoint');
  const above = planFold({ estTokens: high + 1, windowTokens: measuredWindow, policy });
  assert.equal(above.reason, 'band-high');
  assert.ok(Math.abs(above.target - low) < 1e-6);
});

test('calibrateProtect clamps at the first band-high and keeps margin', () => {
  const W = 792576;
  const low = 0.32;
  const at133 = calibrateProtect({ low, windowTokens: W, baselineTokens: 133272 });
  assert.ok(Math.abs(at133.protect - 0.1419) < 0.0001);
  const at150 = calibrateProtect({ low, windowTokens: W, baselineTokens: 150000 });
  assert.ok(Math.abs(at150.protect - 0.1207) < 0.0001);
  const at69 = calibrateProtect({ low, windowTokens: W, baselineTokens: 69257 });
  assert.equal(at69.protect, 0.20);
  const at200 = calibrateProtect({ low, windowTokens: W, baselineTokens: 200000 });
  assert.equal(at200.protect, 0.10);
});
