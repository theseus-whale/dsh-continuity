/**
 * B+C recall scaffold.
 *
 * B is a stable generic concept layer. C is a per-user term map.
 * This module is pure and has no model, network, or live dependency.
 */

export const GENERIC_CONCEPTS = Object.freeze([
  '游戏', '故事', '对话', '技术', '设备', '规则', '记忆', '剧情',
  '病毒', '公共卫生', '科学',
]);

/** No hidden C entries: every term must come from cmap.md. */
export const DEFAULT_C_SEED = Object.freeze([]);

function normalizeTerm(term) {
  return String(term ?? '').trim();
}

export function createCMap(entries = []) {
  const terms = new Map();
  const metadata = new Map();
  for (const entry of entries) {
    const term = normalizeTerm(entry?.term);
    if (!term) continue;
    const generic = [...new Set((entry.generic ?? []).map(normalizeTerm).filter(Boolean))];
    terms.set(term, generic);
    metadata.set(term, {
      generic,
      keywords: [...new Set((entry.keywords ?? []).map(normalizeTerm).filter(Boolean))],
      minB: Number.isInteger(entry.minB) ? entry.minB : 0,
      limit: Number.isInteger(entry.limit) && entry.limit > 0 ? entry.limit : 20,
      summary: typeof entry.summary === 'string' ? entry.summary : '',
    });
  }
  return { terms, asked: new Set(), metadata };
}

export function serializeCMap(cmap) {
  return {
    terms: [...(cmap?.terms ?? new Map()).entries()].map(([term, generic]) => {
      const meta = cmap?.metadata?.get(term) ?? {};
      return {
        term,
        generic: [...generic],
        keywords: [...(meta.keywords ?? [])],
        minB: meta.minB ?? 0,
        summary: meta.summary ?? '',
      };
    }),
    asked: [...(cmap?.asked ?? new Set())],
  };
}

export function deserializeCMap(raw = {}) {
  const cmap = createCMap(Array.isArray(raw.terms) ? raw.terms : []);
  for (const term of raw.asked ?? []) {
    const key = normalizeTerm(term);
    if (key) cmap.asked.add(key);
  }
  return cmap;
}

export function learnTerm(cmap, term, generic, { source = 'user' } = {}) {
  const key = normalizeTerm(term);
  const values = [...new Set((Array.isArray(generic) ? generic : [generic]).map(normalizeTerm).filter(Boolean))];
  if (!key || values.length === 0) return cmap;
  cmap.terms.set(key, values);
  cmap.metadata?.set(key, {
    generic: values,
    keywords: cmap.metadata?.get(key)?.keywords ?? [],
    minB: cmap.metadata?.get(key)?.minB ?? 0,
    limit: cmap.metadata?.get(key)?.limit ?? 20,
    summary: cmap.metadata?.get(key)?.summary ?? '',
  });
  cmap.asked.delete(key);
  cmap.lastLearn = { term: key, generic: values, source };
  return cmap;
}

export function shouldAsk(cmap, term) {
  const key = normalizeTerm(term);
  return key.length > 0 && !cmap.terms.has(key) && !cmap.asked.has(key);
}

export function markAsked(cmap, term) {
  const key = normalizeTerm(term);
  if (key) cmap.asked.add(key);
  return cmap;
}

/** Pick the longest known term/concept present in a sentence. */
export function queryFor(text, { records = [], cmap = createCMap() } = {}) {
  const source = String(text ?? '');
  const candidates = new Set([
    ...GENERIC_CONCEPTS,
    ...(cmap?.terms?.keys?.() ?? []),
    ...records.flatMap((record) => record.terms ?? []),
  ]);
  const present = [...candidates].filter((term) => term.length > 0 && source.includes(term));
  present.sort((a, b) => b.length - a.length);
  return present[0] ?? source.trim();
}

/** Learn from a user's explanation, e.g. "就是游戏、故事、对话". */
export function learnFromExplanation(cmap, term, explanation, { records = [] } = {}) {
  const mentioned = GENERIC_CONCEPTS.filter((concept) => String(explanation ?? '').includes(concept));
  if (mentioned.length === 0) return { ok: false, reason: 'no-generic-concept', generic: [] };
  learnTerm(cmap, term, mentioned, { source: 'user-explanation' });
  return {
    ok: true,
    term: normalizeTerm(term),
    generic: mentioned,
    records: backfillRecords(records, term, mentioned),
  };
}

/** Parse "前两句/上一句/刚才/前面三句" into a reference count. */
export function parseReference(text) {
  const source = String(text ?? '');
  const match = source.match(/前(?:面)?\s*([一二两三四五六七八九十\d]+)\s*句/) ?? source.match(/([一二两三四五六七八九十\d]+)\s*句前/);
  if (match) {
    const token = match[1];
    const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const count = /^\d+$/.test(token) ? Number(token) : (digits[token] ?? Number(token));
    return { kind: 'count', count };
  }
  if (/上一句|刚才|刚刚/.test(source)) return { kind: 'count', count: 1 };
  if (/前面|之前/.test(source)) return { kind: 'recent', count: 3 };
  return null;
}

export function referencedRecords(records = [], count = 1) {
  return records.slice(Math.max(0, records.length - Math.max(1, count)));
}

/**
 * Intersection of the generic labels across evidence records.
 * Background concepts are removed when provided.
 */
export function intersectionConcepts(evidence = [], { background = [] } = {}) {
  if (evidence.length === 0) return { allOf: [], anyOf: [] };
  const sets = evidence.map((record) => new Set(record.generic ?? []));
  const backgroundSet = new Set(background);
  const all = [...sets[0]].filter((concept) => sets.every((set) => set.has(concept)) && !backgroundSet.has(concept));
  const any = [...new Set(evidence.flatMap((record) => record.generic ?? []))].filter((concept) => !backgroundSet.has(concept));
  return { allOf: all, anyOf: any };
}

/** User points at prior turns: "前两句说的就是跑团". */
export function learnFromReference(cmap, term, evidence, records = [], { background = [] } = {}) {
  const { allOf, anyOf } = intersectionConcepts(evidence, { background });
  const generic = allOf.length > 0 ? allOf : anyOf;
  if (generic.length === 0) return { ok: false, reason: 'empty-intersection', allOf, anyOf, generic: [] };
  learnTerm(cmap, term, generic, { source: 'referenced-turns' });
  const learnedRecords = backfillRecords(records, term, generic);
  return { ok: true, term: normalizeTerm(term), allOf, anyOf, generic, records: learnedRecords };
}

export function makeRecord({ turn, seqStart, seqEnd, text, generic = [], genericTopic = null, genericWorkflow = null, topicScore = null, topicConfidence = null, topicMinScore = null, labelVersion = 1, terms = [], confidence = 1, status = 'confirmed', conceptScores = {}, keywords = [], backfilled = [], vec = null, chatter = null, sessionId = null }) {
  return {
    turn: Number.isInteger(turn) ? turn : null,
    seqStart: Number.isInteger(seqStart) ? seqStart : null,
    seqEnd: Number.isInteger(seqEnd) ? seqEnd : seqStart ?? null,
    text: String(text ?? ''),
    generic: [...new Set(generic.map(normalizeTerm).filter(Boolean))],
    ...(Array.isArray(genericTopic) ? { genericTopic: [...new Set(genericTopic.map(normalizeTerm).filter(Boolean))] } : {}),
    ...(Array.isArray(genericWorkflow) ? { genericWorkflow: [...new Set(genericWorkflow.map(normalizeTerm).filter(Boolean))] } : {}),
    ...(Number.isFinite(topicScore) ? { topicScore: Number(topicScore) } : {}),
    ...(typeof topicConfidence === 'string' && topicConfidence ? { topicConfidence } : {}),
    ...(Number.isFinite(topicMinScore) ? { topicMinScore: Number(topicMinScore) } : {}),
    ...(Number.isInteger(labelVersion) ? { labelVersion } : {}),
    terms: [...new Set(terms.map(normalizeTerm).filter(Boolean))],
    keywords: [...new Set(keywords.map(normalizeTerm).filter(Boolean))],
    backfilled: [...new Set(backfilled.map(normalizeTerm).filter(Boolean))],
    confidence: Number(confidence) || 0,
    conceptScores: Object.fromEntries(Object.entries(conceptScores ?? {}).map(([key, value]) => [normalizeTerm(key), Number(value) || 0])),
    status,
    ...(typeof vec === 'string' && vec ? { vec } : {}),
    ...(Number.isFinite(chatter) ? { chatter: Number(chatter) } : {}),
    ...(typeof sessionId === 'string' && sessionId ? { sessionId } : {}),
  };
}

const KEYWORD_STOP = new Set([
  '我们', '你们', '他们', '这个', '那个', '就是', '然后', '因为', '所以', '如果', '但是',
  '已经', '还是', '可以', '没有', '一个', '自己', '什么', '这样', '那样', '现在', '这里',
  '那里', '时候', '一下', '不是', '就是', '以及', '还有', '进行', '东西', '事情',
]);

/** Small, storage-friendly keyword extractor. Not a model. */
export function extractKeywords(text, { limit = 12 } = {}) {
  const source = String(text ?? '').toLowerCase();
  const counts = new Map();
  const add = (word) => {
    if (word.length < 2 || KEYWORD_STOP.has(word)) return;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  };
  for (const word of source.match(/[a-z0-9_]{2,}/g) ?? []) add(word);
  for (const chunk of source.match(/[\u4e00-\u9fff]+/g) ?? []) {
    const chars = [...chunk];
    for (let size = 2; size <= 4; size += 1) {
      for (let index = 0; index + size <= chars.length; index += 1) add(chars.slice(index, index + size).join(''));
    }
  }
  return [...counts.entries()]
    .sort((a, b) => (b[1] * b[0].length) - (a[1] * a[0].length))
    .slice(0, limit)
    .map(([word]) => word);
}

/**
 * Expand a hit by neighboring turns as long as the next turn is adjacent and
 * either shares a high-confidence facet or at least two keywords.
 * No fixed ±3; a generous safety cap prevents runaway growth.
 */
export function expandWindow(records = [], hit, { maxTurns = 100, minFacetScore = 0.4, minKeywordOverlap = 2 } = {}) {
  if (!hit) return { seedTurn: null, turns: [], seqStart: null, seqEnd: null, expanded: false };
  const sorted = [...records].filter((record) => Number.isInteger(record.turn)).sort((a, b) => a.turn - b.turn);
  const index = sorted.findIndex((record) => record.turn === hit.turn && record.seqStart === hit.seqStart);
  if (index < 0) return { seedTurn: hit.turn ?? null, turns: [hit.turn], seqStart: hit.seqStart ?? null, seqEnd: hit.seqEnd ?? null, expanded: false };
  const shared = (a, b) => {
    const facet = a.generic.some((concept) => b.generic.includes(concept)
      && (a.conceptScores?.[concept] ?? 0) >= minFacetScore
      && (b.conceptScores?.[concept] ?? 0) >= minFacetScore);
    const keywordsA = new Set(a.keywords ?? []);
    const overlap = (b.keywords ?? []).filter((word) => keywordsA.has(word)).length;
    return facet || overlap >= minKeywordOverlap;
  };
  let left = index;
  let right = index;
  while (index - left < maxTurns && left > 0) {
    const previous = sorted[left - 1];
    const current = sorted[left];
    if (current.turn - previous.turn > 1 || !shared(previous, current)) break;
    left -= 1;
  }
  while (right - index < maxTurns && right + 1 < sorted.length) {
    const current = sorted[right];
    const next = sorted[right + 1];
    if (next.turn - current.turn > 1 || !shared(current, next)) break;
    right += 1;
  }
  const window = sorted.slice(left, right + 1);
  return {
    seedTurn: hit.turn ?? null,
    turns: window.map((record) => record.turn),
    seqStart: window[0]?.seqStart ?? null,
    seqEnd: window[window.length - 1]?.seqEnd ?? null,
    expanded: window.length > 1,
  };
}

function recordsForConcepts(records, concepts, { minConceptScore = 0, minTopScore = 0, maxTopGap = 0.06, term = null, requireTerm = false } = {}) {
  const wanted = new Set(concepts);
  return records.filter((record) => {
    if (requireTerm && term !== null && !record.terms.includes(term)) return false;
    return record.generic.some((value) => {
      if (!wanted.has(value)) return false;
      const scores = record.conceptScores ?? {};
      const values = Object.values(scores);
      if (values.length === 0) return true;
      const score = scores[value];
      if (score === undefined) return values.length === 0 || (record.backfilled ?? []).includes(value);
      const top = Math.max(...values);
      if (minConceptScore > 0 && score < minConceptScore) return false;
      if (minTopScore > 0 && top < minTopScore) return false;
      if (score < top - maxTopGap) return false;
      return true;
    });
  });
}

/** Learning a term may backfill old records that carry the term but lack the generic label. */
export function backfillRecords(records = [], term, generic = []) {
  const key = normalizeTerm(term);
  const values = [...new Set(generic.map(normalizeTerm).filter(Boolean))];
  if (!key || values.length === 0) return records;
  return records.map((record) => (
    record.terms.includes(key)
      ? {
        ...record,
        generic: [...new Set([...record.generic, ...values])],
        backfilled: [...new Set([...(record.backfilled ?? []), ...values])],
      }
      : record
  ));
}

export function retrieve({ records = [], cmap = createCMap(), query = '', specialKeywords = [], minConceptScore = 0.5, minTopScore = 0.5, maxTopGap = 0.03 } = {}) {
  const term = normalizeTerm(query);
  const specials = [...new Set(specialKeywords.map(normalizeTerm).filter(Boolean))];
  if (specials.length > 0) {
    const wanted = new Set(specials.map((word) => word.toLowerCase()));
    let hits = records.filter((record) => (record.keywords ?? [])
      .some((word) => wanted.has(String(word).toLowerCase())));
    if (hits.length > 0) {
      if (GENERIC_CONCEPTS.includes(term)) {
        const facet = recordsForConcepts(hits, [term], { minConceptScore: 0, minTopScore: 0, maxTopGap: 1 });
        if (facet.length > 0) hits = facet;
      } else if (cmap.terms.has(term)) {
        const facet = recordsForConcepts(hits, cmap.terms.get(term), { minConceptScore: 0, minTopScore: 0, maxTopGap: 1 });
        if (facet.length > 0) hits = facet;
      }
      const facetConcepts = GENERIC_CONCEPTS.includes(term)
        ? [term]
        : (cmap.terms.get(term) ?? []);
      return { kind: 'recall', via: 'K', keywords: specials, concepts: facetConcepts, hits };
    }
    if (!term) return { kind: 'silent', reason: 'no-keyword-record', keywords: specials };
  }
  if (!term) return { kind: 'silent', reason: 'empty-query' };
  if (GENERIC_CONCEPTS.includes(term)) {
    const hits = recordsForConcepts(records, [term], { minConceptScore, minTopScore, maxTopGap });
    return hits.length > 0
      ? { kind: 'recall', via: 'B', concepts: [term], hits }
      : { kind: 'silent', reason: 'no-record', concepts: [term] };
  }
  if (cmap.terms.has(term)) {
    const concepts = cmap.terms.get(term);
    const meta = cmap.metadata?.get(term) ?? { generic: concepts, keywords: [], minB: 0, summary: '' };
    const minB = Number.isInteger(meta.minB) ? meta.minB : 0;
    const kWords = new Set((meta.keywords ?? []).map((word) => String(word).toLowerCase()));
    const hits = records
      .filter((record) => {
        const inTerms = (record.terms ?? []).includes(term);
        const inKeywords = (record.keywords ?? []).includes(term);
        return inTerms || inKeywords;
      })
      .map((record) => {
        const declared = meta.generic ?? concepts;
        const scoreOf = (concept) => {
          const score = record.conceptScores?.[concept];
          if (score !== undefined) return score;
          // Legacy records without conceptScores: fall back to the displayed label.
          return (record.generic ?? []).includes(concept) ? 1 : 0;
        };
        const hasAny = declared.some((concept) => scoreOf(concept) > 0);
        const bCount = declared.filter((concept) => scoreOf(concept) >= 0.5).length;
        const lowB = bCount < minB;
        const kHits = (record.keywords ?? []).filter((word) => kWords.has(String(word).toLowerCase())).length;
        const byTerm = (record.terms ?? []).includes(term);
        const byKeyword = (record.keywords ?? []).includes(term);
        return { ...record, hasAny, lowB, bCount, kHits, byTerm, byKeyword };
      })
      .filter((record) => (minB === 0
        ? (record.hasAny || record.byKeyword)
        : (record.bCount >= minB || record.byTerm || record.byKeyword)))
      .sort((a, b) => (
        Number(b.byTerm) - Number(a.byTerm)
        || Number(a.lowB) - Number(b.lowB)
        || (b.bCount + (b.kHits > 0 ? 0.3 : 0)) - (a.bCount + (a.kHits > 0 ? 0.3 : 0))
        || b.kHits - a.kHits
        || (b.turn ?? 0) - (a.turn ?? 0)
      ));
    const normal = hits.filter((record) => !record.lowB);
    const low = hits.filter((record) => record.lowB);
    const selected = (normal.length >= 3 ? normal : [...normal, ...low.slice(0, 5)])
      .slice(0, Number.isInteger(meta.limit) && meta.limit > 0 ? meta.limit : 20);
    return selected.length > 0
      ? { kind: 'recall', via: 'C', term, concepts, summary: meta.summary ?? '', hits: selected }
      : { kind: 'silent', reason: 'no-record', term, concepts };
  }
  if (shouldAsk(cmap, term)) {
    return { kind: 'ask', term, reason: 'cold-start' };
  }
  return { kind: 'silent', reason: 'already-asked', term };
}

/**
 * High-confidence intersection seeds: every requested concept must be present
 * and above the score floor. This is the narrow seed before any expansion.
 */
export function selectSeeds(records = [], concepts = [], { minConceptScore = 0.3 } = {}) {
  if (concepts.length === 0) return [];
  return records.filter((record) => concepts.every((concept) => {
    if (!record.generic?.includes(concept)) return false;
    const score = record.conceptScores?.[concept];
    return score === undefined || score >= minConceptScore;
  }));
}

/**
 * Group matching turns into intervals. The gap is adaptive: dense hits merge,
 * large gaps between sessions split. No fixed ±N window.
 */
export function groupHits(hits = [], { minGap = 3, maxGap = 30 } = {}) {
  const sorted = [...hits]
    .filter((hit) => Number.isInteger(hit?.turn) || Number.isInteger(hit?.seqStart))
    .sort((a, b) => (a.turn ?? a.seqStart) - (b.turn ?? b.seqStart));
  if (sorted.length === 0) return [];
  const gaps = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1].turn ?? sorted[i - 1].seqStart;
    const next = sorted[i].turn ?? sorted[i].seqStart;
    gaps.push(Math.max(1, next - prev));
  }
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const median = sortedGaps.length === 0 ? 1 : sortedGaps[Math.floor(sortedGaps.length / 2)];
  const threshold = Math.max(minGap, Math.min(maxGap, median * 2));
  const groups = [];
  for (let i = 0; i < sorted.length; i += 1) {
    if (i === 0 || gaps[i - 1] > threshold) {
      groups.push({ hits: [sorted[i]] });
    } else {
      groups[groups.length - 1].hits.push(sorted[i]);
    }
  }
  return groups.map((group) => {
    const first = group.hits[0];
    const last = group.hits[group.hits.length - 1];
    return {
      fromTurn: first.turn,
      toTurn: last.turn,
      fromSeq: first.seqStart,
      toSeq: last.seqEnd ?? last.seqStart,
      hits: group.hits,
      turns: group.hits.length,
      weak: group.hits.some((hit) => hit.status === 'weak' || (hit.backfilled?.length ?? 0) > 0),
    };
  });
}

function intervalLine(group) {
  if (group.fromTurn === null || group.fromTurn === undefined) {
    return `seq ${group.fromSeq}-${group.toSeq}`;
  }
  return group.fromTurn === group.toTurn
    ? `turn ${group.fromTurn} / seq ${group.fromSeq}-${group.toSeq}`
    : `turn ${group.fromTurn}-${group.toTurn} / seq ${group.fromSeq}-${group.toSeq}`;
}

/** Keep the injected note bounded; callers still receive every interval. */
export function formatIntervals(groups, { max = 8, showRemainder = true } = {}) {
  const shown = groups.slice(0, max).map((group) => `- ${intervalLine(group)}`);
  if (showRemainder && groups.length > max) shown.push(`- … 还有 ${groups.length - max} 个区间`);
  return shown.join('\n');
}

/** Warn when a C mapping expands to too many disjoint intervals. */
export function widthWarning(result, groups, { max = 20 } = {}) {
  if (result?.via !== 'C' || groups.length <= max) return null;
  return `[宽命中] 这条 C 映射产生 ${groups.length} 个区间，建议改 K（精确名字）或拆分 cmap 条目。`;
}

export function renderNote(result) {
  if (result?.kind === 'ask') {
    return `[问] 你说的“${result.term}”是指什么？可以简单说几个近义词。`;
  }
  if (result?.kind !== 'recall' || result.hits.length === 0) return null;
  const label = result.via === 'C'
    ? result.term
    : result.via === 'K'
      ? `${result.keywords.join(' + ')}${result.concepts?.length ? ' · ' + result.concepts.join(' / ') : ''}`
      : result.concepts.join(' / ');
  const groups = groupHits(result.hits);
  const weak = groups.some((group) => group.weak) ? ' · weak' : '';
  const warning = widthWarning(result, groups);
  const tail = (warning ? `\n${warning}` : '') + '\n如需上下文，可按需前后读更多 turn。';
  if (groups.length === 1) {
    return `[追忆] ${label}${weak} -> ${intervalLine(groups[0])}${tail}`;
  }
  return `[追忆] ${label}${weak} -> ${groups.length} 个区间 / ${result.hits?.length ?? 0} 条记录\n${formatIntervals(groups)}${tail}`;
}

/** Public tool alias: the LLM-facing name is recall(). */
export function recall(options = {}) {
  return retrieve(options);
}
