/**
 * EventModel: stable situation slots and boundary strength.
 *
 * Unlike facets, these slots describe the current situation. A topic change
 * alone is not a boundary; location/characters/goal changes are stronger.
 */

const WEIGHTS = Object.freeze({
  location: 0.35,
  characters: 0.30,
  goal: 0.25,
  objects: 0.10,
  activity: 0.10,
  topic: 0,
});

const LOCATION_STOP = new Set(['这里', '那里', '现在', '刚才', '地方', '时候', '什么', '一个']);
const LOCATION_TERMS = ['灯室', '钟楼', '矿口', '石屋', '旧镇', '库房', '码头', '地窖', '院子', '木棚', '悬崖'];

export function validateEventSlots(input = {}) {
  const errors = [];
  const allowed = new Set(['location', 'characters', 'goal', 'objects', 'activity', 'topic']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) errors.push({ key, reason: 'unknown-slot' });
  }
  for (const key of ['location', 'goal', 'activity', 'topic']) {
    const value = input[key];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      errors.push({ key, reason: 'not-a-string' });
    } else if (typeof value === 'string' && value.length > 40) {
      errors.push({ key, reason: 'too-long' });
    }
  }
  for (const key of ['characters', 'objects']) {
    const value = input[key];
    if (value !== undefined && value !== null && !Array.isArray(value)) {
      errors.push({ key, reason: 'not-an-array' });
    } else if (Array.isArray(value)) {
      if (value.length > 20) errors.push({ key, reason: 'too-many' });
      for (const item of value) {
        if (typeof item !== 'string') errors.push({ key, reason: 'item-not-string' });
        else if (item.length > 40) errors.push({ key, reason: 'item-too-long' });
      }
    }
  }
  return { ok: errors.length === 0, errors, slots: normalizeEventSlots(input) };
}

export function normalizeEventSlots(input = {}) {
  const array = (value) => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value])
    .map((item) => String(item).trim())
    .filter(Boolean);
  const scalar = (value) => {
    const text = value === undefined || value === null ? '' : String(value).trim();
    return text.length === 0 ? null : text;
  };
  return {
    location: scalar(input.location),
    characters: [...new Set(array(input.characters))],
    goal: scalar(input.goal),
    objects: [...new Set(array(input.objects))],
    activity: scalar(input.activity),
    topic: scalar(input.topic),
  };
}

function scalarChanged(a, b) {
  if (a === null || b === null) return 0;
  return a === b ? 0 : 1;
}

function setChanged(a, b) {
  if (a.length === 0 || b.length === 0) return 0;
  const left = new Set(a);
  const right = new Set(b);
  let same = 0;
  for (const item of left) if (right.has(item)) same += 1;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : 1 - same / union;
}

export function boundaryScore(previous, next) {
  if (previous === null || previous === undefined) return 1;
  const a = normalizeEventSlots(previous);
  const b = normalizeEventSlots(next);
  const changed = {
    location: scalarChanged(a.location, b.location),
    characters: setChanged(a.characters, b.characters),
    goal: scalarChanged(a.goal, b.goal),
    objects: setChanged(a.objects, b.objects),
    activity: scalarChanged(a.activity, b.activity),
    topic: scalarChanged(a.topic, b.topic),
  };
  const score = Object.entries(WEIGHTS).reduce((sum, [slot, weight]) => sum + weight * changed[slot], 0);
  return { score: +score.toFixed(4), changed };
}

export class EventModelState {
  constructor({ eventId = 0, slots = null, threshold = 0.35 } = {}) {
    this.eventId = eventId;
    this.slots = slots === null ? null : normalizeEventSlots(slots);
    this.threshold = threshold;
  }

  observe({ slots, explicitBoundary = false } = {}) {
    const checked = validateEventSlots(slots);
    if (!checked.ok) {
      return { eventId: this.eventId, boundary: false, score: 0, error: 'invalid-slots', errors: checked.errors, slots: this.slots };
    }
    const next = checked.slots;
    const result = boundaryScore(this.slots, next);
    const boundary = explicitBoundary || this.slots === null || result.score >= this.threshold;
    if (boundary && this.slots !== null) this.eventId += 1;
    this.slots = next;
    return {
      eventId: this.eventId,
      boundary,
      score: this.slots === null ? 1 : result.score,
      changed: this.slots === null ? {} : result.changed,
      slots: next,
    };
  }
}

export function extractEventSlots(text, { characters = [] } = {}) {
  const source = String(text ?? '');
  const location = [...LOCATION_TERMS].sort((a, b) => b.length - a.length).find((term) => source.includes(term)) ?? null;
  const foundCharacters = characters.filter((name) => name.length > 0 && source.includes(name));
  const objects = ['钥匙', '账册', '信', '名册', '收条', '罐子', '灯', '门', '钟', '船', '布标']
    .filter((object) => source.includes(object));
  return normalizeEventSlots({ location, characters: foundCharacters, objects });
}
