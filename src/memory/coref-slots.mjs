/**
 * Coreference output -> EventModel slots and referent candidates.
 * Input clusters are expected to be normalizeCoref() output.
 */

function isLikelyName(text) {
  return /^[A-Z][A-Za-z0-9'_-]{1,30}$/u.test(String(text ?? '').trim());
}

export function corefReferents(clusters = []) {
  const referents = [];
  for (const cluster of clusters) {
    const canonical = cluster.canonical ?? cluster.mentions?.find((m) => m.isCanonical)?.text ?? null;
    if (!canonical) continue;
    referents.push({
      clusterId: cluster.clusterId ?? null,
      canonical,
      mentions: (cluster.mentions ?? []).map((mention) => mention.text),
    });
  }
  return referents;
}

export function applyCorefToSlots(slots = {}, clusters = []) {
  const next = {
    characters: [...(slots.characters ?? [])],
    location: slots.location ?? null,
    goal: slots.goal ?? null,
    objects: [...(slots.objects ?? [])],
  };
  const referents = corefReferents(clusters);
  for (const referent of referents) {
    if (isLikelyName(referent.canonical)) {
      if (!next.characters.includes(referent.canonical)) next.characters.push(referent.canonical);
    } else if (!next.objects.includes(referent.canonical)) {
      next.objects.push(referent.canonical);
    }
  }
  return { slots: next, referents };
}
