/**
 * Composite provider: NER is required; coref, SRL, and EL are optional.
 * Optional failures are recorded but do not discard NER slots.
 */
function mergeSlots(base = {}, extra = {}) {
  const slots = {
    characters: [...(base.characters ?? [])],
    location: base.location ?? null,
    goal: base.goal ?? null,
    objects: [...(base.objects ?? [])],
  };
  for (const name of extra.characters ?? []) {
    if (!slots.characters.includes(name)) slots.characters.push(name);
  }
  for (const item of extra.objects ?? []) {
    if (!slots.objects.includes(item)) slots.objects.push(item);
  }
  slots.location ??= extra.location ?? null;
  slots.goal ??= extra.goal ?? null;
  return slots;
}

function candidatesFrom(data) {
  const names = [
    ...(data?.slots?.characters ?? []),
    ...(data?.slots?.objects ?? []),
    ...(data?.entities ?? []).map((entity) => entity.text),
  ];
  return [...new Set(names.filter((item) => typeof item === 'string' && item.trim()))];
}

export function createCompositeProvider({ ner, coref = null, srl = null, el = null, candidates = candidatesFrom } = {}) {
  if (!ner) throw new TypeError('ner provider is required');
  return {
    mode: 'composite',
    close() {
      for (const provider of [ner, coref, srl, el]) provider?.close?.();
    },
    async extract({ text } = {}) {
      const started = Date.now();
      const nerResult = await ner.extract({ text });
      if (!nerResult.ok) return { ...nerResult, source: 'composite', latencyMs: Date.now() - started };
      const parts = { ner: nerResult };
      const optional = {};
      if (coref) optional.coref = await coref.extract({ text });
      if (srl) optional.srl = await srl.extract({ text });
      if (el) optional.el = await el.extract({ text, candidates: candidates(nerResult.data) });

      let slots = { ...(nerResult.data?.slots ?? {}) };
      let srlData = null;
      if (optional.srl?.ok) {
        srlData = optional.srl.data?.srl ?? optional.srl.data;
        const { srlToSlots } = await import('./structured-adapters.mjs');
        slots = mergeSlots(slots, srlToSlots(srlData).slots);
      }
      return {
        ok: true,
        source: 'composite',
        latencyMs: Date.now() - started,
        data: {
          ...nerResult.data,
          slots,
          srl: srlData,
          corefClusters: optional.coref?.ok ? (optional.coref.data?.clusters ?? []) : [],
          entityLinks: optional.el?.ok ? (optional.el.data?.links ?? []) : [],
          partial: {
            coref: optional.coref ? { ok: optional.coref.ok, reason: optional.coref.reason ?? null, stderr: optional.coref.stderr ?? null } : null,
            srl: optional.srl ? { ok: optional.srl.ok, reason: optional.srl.reason ?? null, stderr: optional.srl.stderr ?? null } : null,
            el: optional.el ? { ok: optional.el.ok, reason: optional.el.reason ?? null, stderr: optional.el.stderr ?? null } : null,
          },
        },
      };
    },
  };
}
