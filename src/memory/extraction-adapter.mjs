/**
 * Adapter from extractor output to EventModel slots and the pre-turn gate.
 * Extractor output is validated before it can affect state.
 */
import { mapEntitiesToSlots } from './extraction-core.mjs';
import { validateEventSlots } from './event-model.mjs';
import { applyCorefToSlots } from './coref-slots.mjs';
import { srlToSlots, normalizeEntityLinks } from './structured-adapters.mjs';

export function attachExtraction(controller, { text, role = 'user', entities = [], slots = null, facets = {}, confidence = 1, nowTurn = 0, corefClusters = [] }) {
  const mapped = slots ?? mapEntitiesToSlots(entities);
  const withCoref = applyCorefToSlots(mapped, corefClusters);
  const checked = validateEventSlots(withCoref.slots);
  if (!checked.ok) {
    return {
      ok: false,
      reason: 'invalid-slots',
      errors: checked.errors,
      entities,
      slots: null,
      gate: null,
    };
  }
  const gate = controller.step({
    text,
    role,
    facets,
    confidence,
    eventSlots: checked.slots,
    nowTurn,
  });
  return { ok: true, entities, slots: checked.slots, referents: withCoref.referents, gate };
}

export function attachStructuredExtraction(controller, {
  text,
  role = 'user',
  facets = {},
  confidence = 1,
  nowTurn = 0,
  slots = null,
  srl = null,
  corefClusters = [],
  entityLinks = [],
}) {
  const fromSrl = srl ? srlToSlots(srl) : null;
  const withCoref = applyCorefToSlots(slots ?? fromSrl?.slots ?? {}, corefClusters);
  const checked = validateEventSlots(withCoref.slots);
  if (!checked.ok) {
    return {
      ok: false,
      reason: 'invalid-slots',
      errors: checked.errors,
      slots: null,
      referents: withCoref.referents,
      entityLinks: normalizeEntityLinks(entityLinks),
      gate: null,
    };
  }
  const gate = controller.step({
    text,
    role,
    facets,
    confidence,
    eventSlots: checked.slots,
    nowTurn,
  });
  return {
    ok: true,
    predicate: fromSrl?.predicate ?? null,
    slots: checked.slots,
    referents: withCoref.referents,
    entityLinks: normalizeEntityLinks(entityLinks),
    gate,
  };
}
