/**
 * Pure oldest-range selection for the band controller. No DSH imports.
 *
 * The engine supplies the session surface, each surface node's route-priced
 * token count, and the two tool-pairing predicates. This module owns only the
 * arithmetic and the edge rules:
 *
 *   - never include a system head at surface position 0;
 *   - take the oldest contiguous prefix so the summary replaces "the beginning";
 *   - stop at `budget` and leave at least `tailFloor` tokens after the cut;
 *   - move the end backwards until the trailing cut is balanced;
 *   - return null when no balanced span fits.
 */

/**
 * @param {object} input
 * @param {readonly (number|string)[]} input.surfaceSeqs current surface positions, oldest first
 * @param {readonly number[]} input.pricedTokens route-priced tokens per position
 * @param {boolean} [input.systemHead] true when position 0 is the system message
 * @param {number} input.budget maximum route-priced tokens to shadow in this pass
 * @param {number} [input.tailFloor] minimum route-priced tokens that must remain after the cut
 * @param {(seq: number|string) => boolean} input.balancedBefore leading-cut predicate
 * @param {(seq: number|string) => boolean} input.balancedAfter trailing-cut predicate
 * @returns {{ startIdx: number, endIdx: number, tokens: number } | null}
 */
export function selectOldestRange({
  surfaceSeqs,
  pricedTokens,
  systemHead = false,
  budget,
  tailFloor = 0,
  balancedBefore,
  balancedAfter,
}) {
  if (!Array.isArray(surfaceSeqs) || surfaceSeqs.length === 0) return null;
  if (!Array.isArray(pricedTokens) || pricedTokens.length !== surfaceSeqs.length) return null;
  if (!Number.isFinite(budget) || budget <= 0) return null;
  if (typeof balancedBefore !== 'function' || typeof balancedAfter !== 'function') {
    throw new TypeError('selectOldestRange needs both balance predicates');
  }

  const firstIdx = systemHead ? 1 : 0;
  if (firstIdx >= surfaceSeqs.length) return null;

  let surfaceTotal = 0;
  for (const tokens of pricedTokens) surfaceTotal += Number.isFinite(tokens) ? tokens : 0;

  let accumulated = 0;
  let endIdx = -1;
  for (let index = firstIdx; index < surfaceSeqs.length; index += 1) {
    const tokens = Number.isFinite(pricedTokens[index]) ? pricedTokens[index] : 0;
    const remainingAfter = surfaceTotal - accumulated - tokens;
    // Leaving less than the protected tail after the cut is never allowed:
    // that is the "recent verbatim window" the policy refuses to fold.
    if (remainingAfter < tailFloor) break;
    if (accumulated + tokens > budget) break;
    accumulated += tokens;
    endIdx = index;
  }
  if (endIdx < firstIdx) return null;

  // A balanced trailing cut can only move earlier, which keeps the pass small
  // and leaves more of the recent tail untouched.
  while (endIdx >= firstIdx && !balancedAfter(surfaceSeqs[endIdx])) endIdx -= 1;
  if (endIdx < firstIdx) return null;
  if (!balancedBefore(surfaceSeqs[firstIdx])) return null;

  let tokens = 0;
  for (let index = firstIdx; index <= endIdx; index += 1) {
    tokens += Number.isFinite(pricedTokens[index]) ? pricedTokens[index] : 0;
  }
  return { startIdx: firstIdx, endIdx, tokens };
}

export default selectOldestRange;
