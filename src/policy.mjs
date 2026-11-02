/**
 * Pure band-controller policy. No DSH imports, no I/O, no side effects:
 * the adapter and its tests both call these functions.
 *
 * The policy answers one question per turn: "how many tokens should this
 * compaction pass remove?" It does not decide *what* to remove; the engine
 * chooses the oldest balanced range (or a prune set) and does it.
 */

/**
 * Cache-first band: one pass at the high water mark moves the oldest contiguous
 * range toward `low`, so the number of prefix rewrites is minimised. The pass is
 * bounded by `maxPerBatch` and by the protected tail; with a fixed baseline the
 * effective floor can be above `low` (protect + baseline). `setpoint === high`
 * is deliberate: the proportional band would otherwise add smaller passes
 * between them, and every pass invalidates the provider's cached suffix. The
 * default hard cap is 515k of the 1,048k window: high 60% W starts the drain,
 * low 40% W is the target, and emergency 65% W is the 515k last-resort trigger.
 * The high→emergency gap is 5% W (39,628), deliberately above minAction 24k.
 *
 * Measured on the 53-pass Continuity session: 698,108 tokens were removed in
 * total; at this band a pass is ~158k, so the same history is ~5 passes, not 53.
 */
export const CACHE_FIRST_POLICY = Object.freeze({
  /** `setpoint === high`: no proportional pass fires before the drain. */
  setpoint: 0.60,
  /** Above this fraction, start a pass whose budget targets `low` (upper bound). */
  high: 0.60,
  /** Target request when above `high`; effective floor is protect + baseline. */
  low: 0.40,
  /** Above this fraction, ignore `maxPerBatch` and drain to `emergencyTo`. */
  emergency: 0.65,
  /** Drain target; below `high` so one emergency does not chain into band-high. */
  emergencyTo: 0.42,
  /** Proportional gain (only used by the gradual variant). */
  k: 0.4,
  /** Hard cap on tokens folded in one pass: enough to drain high→low. */
  maxPerBatch: 190000,
  /** Do nothing below this many tokens: avoids rewriting the prefix for a sliver. */
  minAction: 24000,
  /** Never fold below this fraction of the window (recent verbatim tail). */
  protect: 0.30,
});

/**
 * Same water marks with a proportional zone between 50% and 60%. Smoother
 * average context, but each proportional pass is another prefix invalidation;
 * use only when cache hit rate is not the priority.
 */
export const CACHE_GRADUAL_POLICY = Object.freeze({
  ...CACHE_FIRST_POLICY,
  setpoint: 0.50,
});

/** The engine default. Kept as a named alias for existing callers/tests. */
export const DEFAULT_POLICY = CACHE_FIRST_POLICY;

const NAMES = Object.keys(DEFAULT_POLICY);

/** Coerce partial config into a complete, validated policy. */
export function resolvePolicy(overrides = {}) {
  if (overrides == null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('policy must be an object');
  }
  const unknown = Object.keys(overrides).filter((key) => !NAMES.includes(key));
  if (unknown.length) throw new TypeError(`unknown policy key: ${unknown.join(', ')}`);
  const policy = { ...DEFAULT_POLICY };
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`policy.${key} must be a finite number`);
    }
    if (value < 0) throw new TypeError(`policy.${key} must be >= 0`);
    policy[key] = value;
  }
  for (const key of ['setpoint', 'high', 'low', 'emergency', 'emergencyTo', 'protect']) {
    if (policy[key] > 1) throw new TypeError(`policy.${key} must be <= 1`);
  }
  if (!(policy.low < policy.high && policy.high <= policy.emergency && policy.emergency <= 1)) {
    throw new TypeError('policy must satisfy low < high <= emergency <= 1');
  }
  if (!(policy.setpoint > policy.low && policy.setpoint <= policy.high)) {
    throw new TypeError('policy must satisfy low < setpoint <= high');
  }
  if (policy.emergencyTo >= policy.emergency) {
    throw new TypeError('policy.emergencyTo must be below policy.emergency');
  }
  if (policy.maxPerBatch <= 0) throw new TypeError('policy.maxPerBatch must be > 0');
  if (policy.minAction < 0) throw new TypeError('policy.minAction must be >= 0');
  return Object.freeze(policy);
}

/**
 * Plan one pass.
 *
 * @param {{ estTokens: number, windowTokens: number, policy?: object }} input
 *   `estTokens` is the measured context occupancy; `windowTokens` is the
 *   model's usable window after the output reserve.
 * @returns {{ budget: number, reason: 'invalid'|'below-setpoint'|'deadband'|'setpoint'|'band-high'|'emergency'|'protected', target: number|null }}
 */
export function planFold({ estTokens, windowTokens, policy = DEFAULT_POLICY }) {
  const p = policy;
  if (!Number.isFinite(estTokens) || !Number.isFinite(windowTokens) || windowTokens <= 0) {
    return { budget: 0, reason: 'invalid', target: null };
  }
  if (estTokens <= p.setpoint * windowTokens) {
    return { budget: 0, reason: 'below-setpoint', target: p.setpoint * windowTokens };
  }

  let budget;
  let reason;
  let target;
  if (estTokens > p.emergency * windowTokens) {
    target = p.emergencyTo * windowTokens;
    budget = estTokens - target;
    reason = 'emergency';
  } else if (estTokens > p.high * windowTokens) {
    target = p.low * windowTokens;
    budget = estTokens - target;
    reason = 'band-high';
  } else {
    target = p.setpoint * windowTokens;
    budget = p.k * (estTokens - target);
    reason = 'setpoint';
  }

  // Never fold into the protected recent window.
  const foldable = Math.max(0, estTokens - p.protect * windowTokens);
  budget = Math.min(budget, foldable);
  if (reason !== 'emergency') budget = Math.min(budget, p.maxPerBatch);

  if (budget <= 0) return { budget: 0, reason: 'protected', target };
  if (reason !== 'emergency' && budget < p.minAction) {
    return { budget: 0, reason: 'deadband', target };
  }
  return { budget, reason, target };
}

/** True when the band is above its setpoint but the deadband is withholding action. */
export function shouldWait({ estTokens, windowTokens, policy = DEFAULT_POLICY }) {
  return planFold({ estTokens, windowTokens, policy }).reason === 'deadband';
}

export default DEFAULT_POLICY;
