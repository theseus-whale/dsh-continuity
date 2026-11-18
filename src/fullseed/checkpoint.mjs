export const MAX_FINITE_CHECKPOINT = Number.MAX_SAFE_INTEGER;

/**
 * Fullseed checkpoint must be finite before anything can be written: an
 * Infinity checkpoint becomes null in JSONL and is filtered by retrieval.
 * The dryrun may omit it, but an approved run must fail closed.
 */
export function normalizeCheckpoint(value, { approve = false } = {}) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  if (approve) throw new Error('--checkpoint must be a finite integer for an approved run');
  return MAX_FINITE_CHECKPOINT;
}
