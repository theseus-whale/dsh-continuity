import { createHash } from 'node:crypto';

export function rulesCarrierSignature(rulesText, habitsText) {
  return createHash('sha256').update(JSON.stringify([String(rulesText ?? ''), String(habitsText ?? '')]), 'utf8').digest('hex');
}

export function rulesCarrierMetadata(signature) {
  return { version: 1, signature };
}

export const RULES_FULL_MARKERS = ['[规矩·rules.md 全文]', '[习惯·habits.md 全文]'];

/** Find full-text carriers on the current surface, including wrapped event data. */
export function findRulesCarrierSeqs(session) {
  const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : [];
  const found = [];
  for (const seq of nodes) {
    const event = typeof session?.eventAt === 'function' ? session.eventAt(seq) : null;
    const message = event?.data?.message ?? event?.data;
    const text = typeof message?.content === 'string' ? message.content : Array.isArray(message?.content) ? message.content.map(part => part?.text ?? '').join('\n') : '';
    if (RULES_FULL_MARKERS.some(marker => text.includes(marker))) found.push(seq);
  }
  return found;
}

/** Read the persisted carrier signature from either wrapped or direct event.data. */
export function readRulesCarrierSignature(event) {
  const message = event?.data?.message ?? event?.data;
  const metadata = message?.source?.continuityRules;
  return metadata?.version === 1 && typeof metadata?.signature === 'string' ? metadata.signature : null;
}

/**
 * Decide one carrier action from persisted surface state.
 * `carrier` is { seq, event } for the currently selected carrier.
 * Returns action none | append | replace, with the target seq for replace.
 */
export function planRulesLifecycle({ hasContent, signature, carrier = null, surfaceSeqs = [] }) {
  const surface = surfaceSeqs instanceof Set ? surfaceSeqs : new Set(surfaceSeqs);
  const alive = carrier !== null && carrier !== undefined && surface.has(Number(carrier.seq));
  if (alive) {
    const persisted = readRulesCarrierSignature(carrier.event);
    if (persisted === signature) return { action: 'none', reason: 'unchanged-visible', seq: Number(carrier.seq) };
    return {
      action: 'replace',
      reason: persisted === null ? 'legacy-or-missing-signature' : 'content-changed',
      seq: Number(carrier.seq),
    };
  }
  if (hasContent) return { action: 'append', reason: carrier ? 'carrier-folded' : 'missing-carrier', seq: null };
  return { action: 'none', reason: 'empty-without-carrier', seq: null };
}
