/**
 * 0.8.6 start/skip resolver for the normal (surface) save path.
 * Backfill is deliberately not here: an explicit range below surface[0]
 * folds from surface[0] and reports the skipped hole; it never throws.
 */
export function resolveSaveStart({ explicitFrom, surfaceFirst }) {
  const floor = Number(surfaceFirst);
  const requested = explicitFrom === undefined || explicitFrom === null ? null : Number(explicitFrom);
  if (!Number.isFinite(floor)) return { startFrom: requested, belowSurface: false };
  if (requested === null) return { startFrom: floor, belowSurface: false };
  if (requested < floor) return { startFrom: floor, belowSurface: true };
  return { startFrom: requested, belowSurface: false };
}

export function detectSkippedRange({ coveredTo, surfaceFirst, events = [] }) {
  const floor = Number(surfaceFirst);
  const covered = Number(coveredTo);
  if (!Number.isFinite(floor) || !Number.isFinite(covered)) return null;
  const from = covered + 1;
  const to = floor - 1;
  if (to < from) return null;
  const count = (Array.isArray(events) ? events : []).filter((event) => {
    const seq = Number(event?.seq);
    return Number.isInteger(seq) && seq >= from && seq <= to
      && (event?.type === 'user/message' || event?.type === 'assistant/message');
  }).length;
  if (count === 0) return null;
  return { from, to, events: count };
}
