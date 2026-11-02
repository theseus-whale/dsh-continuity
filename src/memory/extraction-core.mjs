/**
 * Extraction core: route language, call a provider, validate entities and map
 * them to EventModel slots. Providers are replaceable (HanLP, spaCy, XLM-R...).
 */
import { routeLanguage } from './language-router.mjs';
import { validateEventSlots } from './event-model.mjs';

const SLOT_BY_LABEL = Object.freeze({
  PERSON: 'characters',
  PER: 'characters',
  NAME: 'characters',
  LOC: 'location',
  LOCATION: 'location',
  GPE: 'location',
  FAC: 'location',
  ADDRESS: 'location',
  SCENE: 'location',
  OBJECT: 'objects',
  MISC: 'objects',
  PROPER: 'objects',
  ORG: 'objects',
  COMPANY: 'objects',
  ORGANIZATION: 'objects',
  GOVERNMENT: 'objects',
  BOOK: 'objects',
  MOVIE: 'objects',
  GAME: 'objects',
});

function validEntity(entity) {
  return entity !== null
    && typeof entity === 'object'
    && typeof entity.text === 'string'
    && entity.text.length > 0
    && typeof entity.label === 'string'
    && (entity.start === undefined || Number.isInteger(entity.start))
    && (entity.end === undefined || Number.isInteger(entity.end));
}

export function mapEntitiesToSlots(entities) {
  const slots = { characters: [], location: null, objects: [] };
  for (const entity of entities) {
    const slot = SLOT_BY_LABEL[entity.label.toUpperCase()];
    if (slot === 'characters') slots.characters.push(entity.text);
    else if (slot === 'location' && slots.location === null) slots.location = entity.text;
    else if (slot === 'objects') slots.objects.push(entity.text);
  }
  slots.characters = [...new Set(slots.characters)];
  slots.objects = [...new Set(slots.objects)];
  return slots;
}

export function createExtractionCore({ providers = {}, fallback = null } = {}) {
  return {
    extract(text) {
      const route = routeLanguage(text);
      const provider = providers[route.language] ?? providers.mixed ?? fallback;
      if (typeof provider !== 'function') {
        return { ok: false, language: route.language, reason: 'no-provider', entities: [], slots: null };
      }
      let output;
      try {
        output = provider(text, route);
      } catch (error) {
        return { ok: false, language: route.language, reason: 'provider-error', error: String(error), entities: [], slots: null };
      }
      const entities = Array.isArray(output?.entities) ? output.entities.filter(validEntity) : [];
      const mapped = output?.slots ?? mapEntitiesToSlots(entities);
      const checked = validateEventSlots(mapped);
      if (!checked.ok) {
        return { ok: false, language: route.language, reason: 'invalid-slots', errors: checked.errors, entities, slots: null };
      }
      return { ok: true, language: route.language, route, entities, slots: checked.slots };
    },
  };
}
