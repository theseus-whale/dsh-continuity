/**
 * Read-only legacy cue audit. Production injection paths must not import this
 * module: it exists only to inspect historical raw/surface records.
 */
export const LEGACY_ACTIVE_CUE_SOURCE = 'turn-ping-memory';
export const LEGACY_RETIRED_CUE_SOURCE = 'turn-ping-retired';

export function isLegacyActiveCueMessage(message) {
  const kind = message?.source?.kind ?? message?.data?.source?.kind ?? null;
  return kind === LEGACY_ACTIVE_CUE_SOURCE;
}

export function isLegacyRetiredCueMessage(message) {
  const kind = message?.source?.kind ?? message?.data?.source?.kind ?? null;
  return kind === LEGACY_RETIRED_CUE_SOURCE;
}

/** Distinguish an active old cue, a retirement tombstone, and unrelated text. */
export function classifyLegacyCue(message) {
  if (isLegacyActiveCueMessage(message)) return 'active-legacy';
  if (isLegacyRetiredCueMessage(message)) return 'retired-legacy';
  return 'not-legacy';
}
