/**
 * Adapters for future SRL / coreference / entity-linking model outputs.
 * They normalize model output into EventModel slots and referent candidates.
 */

const AGENT_LABELS = new Set(['ARG0', 'A0']);
const PATIENT_LABELS = new Set(['ARG1', 'A1']);
const LOCATION_LABELS = new Set(['ARGM-LOC', 'AM-LOC', 'LOC']);
const GOAL_LABELS = new Set(['ARGM-GOL', 'AM-GOL', 'GOL']);

export function normalizeSrl({ predicate = null, arguments: args = [] } = {}) {
  const slots = { characters: [], location: null, goal: null, objects: [] };
  for (const arg of args) {
    if (typeof arg?.text !== 'string') continue;
    const label = String(arg.label ?? '').toUpperCase();
    if (AGENT_LABELS.has(label)) slots.characters.push(arg.text);
    else if (PATIENT_LABELS.has(label)) slots.objects.push(arg.text);
    else if (LOCATION_LABELS.has(label) && slots.location === null) slots.location = arg.text;
    else if (GOAL_LABELS.has(label)) slots.goal = arg.text;
  }
  slots.characters = [...new Set(slots.characters)];
  slots.objects = [...new Set(slots.objects)];
  return { predicate, slots };
}

export function srlToSlots({ words = [], tags = [], verb = null } = {}) {
  const groups = [];
  let current = null;
  for (let index = 0; index < tags.length; index += 1) {
    const tag = String(tags[index] ?? 'O');
    if (tag === 'O' || tag.startsWith('B-')) {
      if (current) groups.push(current);
      current = tag === 'O' ? null : { label: tag.slice(2), words: [] };
    }
    if (current) current.words.push(words[index]);
  }
  if (current) groups.push(current);
  const slots = { characters: [], location: null, goal: null, objects: [] };
  for (const group of groups) {
    const text = group.words.join(' ');
    if (!text) continue;
    if (AGENT_LABELS.has(group.label)) slots.characters.push(text);
    else if (PATIENT_LABELS.has(group.label)) slots.objects.push(text);
    else if (LOCATION_LABELS.has(group.label) || group.label === 'ARGM-DIR') slots.location ??= text;
    else if (GOAL_LABELS.has(group.label)) slots.goal ??= text;
  }
  slots.characters = [...new Set(slots.characters)];
  slots.objects = [...new Set(slots.objects)];
  return { predicate: verb, slots };
}

export function normalizeCoref(clusters = []) {
  return clusters.map((cluster, index) => {
    const mentions = (cluster.mentions ?? []).filter((mention) => typeof mention.text === 'string');
    const canonical = mentions.find((mention) => mention.isCanonical) ?? mentions[0] ?? null;
    return {
      clusterId: `coref:${index + 1}`,
      canonical: canonical?.text ?? null,
      mentions: mentions.map((mention) => ({
        text: mention.text,
        start: mention.start ?? null,
        end: mention.end ?? null,
      })),
    };
  });
}

export function normalizeEntityLinks(links = []) {
  return links.map((link) => ({
    text: String(link.text ?? ''),
    entityId: link.entityId ?? null,
    referent: link.entityId === null || link.entityId === undefined ? 'NIL' : String(link.entityId),
    score: Number.isFinite(link.score) ? link.score : null,
  }));
}
