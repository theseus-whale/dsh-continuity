/**
 * Retrieval planner: route a query to the most appropriate layer, with
 * explicit coverage/score gates instead of always fusing every layer.
 */
import { buildFacetIndex, queryFacets } from '../facets/index.mjs';
import { DEFAULT_ALIASES, aliasFacets } from '../facets/schema.mjs';
import { BM25Index } from './bm25.mjs';

export function reciprocalRankFusion(lists, { k = 60, weights = {} } = {}) {
  const scores = new Map();
  for (const [layer, hits] of Object.entries(lists)) {
    const weight = weights[layer] ?? 1;
    hits.forEach((hit, index) => {
      const key = hit.turn;
      const add = weight / (k + index + 1);
      const current = scores.get(key) ?? { turn: key, sources: {}, score: 0, hit };
      current.score += add;
      current.sources[layer] = (current.sources[layer] ?? 0) + add;
      scores.set(key, current);
    });
  }
  return [...scores.values()].sort((a, b) => b.score - a.score);
}

function isLastIntent(query) {
  return /上次|最近|刚才|上一次/.test(query);
}

function asOfFilter(hits, asOf) {
  if (!Number.isInteger(asOf)) return hits;
  return hits.filter((hit) => hit.turn <= asOf);
}

function orderHits(hits, last) {
  return last ? [...hits].sort((a, b) => b.turn - a.turn) : hits;
}

export function buildPlanner({ records, bm25, vectorIndex, summaryBm25 }) {
  const facetIndex = buildFacetIndex(records);
  return {
    query(query, { queryVector = null, topK = 20, asOf = null } = {}) {
      const last = isLastIntent(query);
      const cleanQuery = String(query).replace(/^(上次的?|最近的?|刚才的?|上一次的?)\s*/u, '').trim() || String(query);
      const routeSuffix = last ? '-last' : '';
      const facetAliasKey = Object.keys(DEFAULT_ALIASES).find((key) => cleanQuery.includes(key));
      const facetAlias = facetAliasKey === undefined ? {} : aliasFacets(facetAliasKey);
      if (Object.keys(facetAlias).length > 0) {
        const matches = asOfFilter(queryFacets(facetIndex, facetAliasKey, { topK: records.length }).matches, asOf);
        return {
          query,
          route: `facet${routeSuffix}`,
          layers: ['facet'],
          facet: facetAlias,
          fused: orderHits(matches, last).slice(0, topK).map((hit) => ({
            turn: hit.turn,
            seqStart: hit.seqStart,
            seqEnd: hit.seqEnd,
            score: hit.score,
            sources: { facet: hit.score },
          })),
        };
      }

      const visible = Number.isInteger(asOf) ? records.filter((record) => record.turn <= asOf) : records;
      const lastQuery = cleanQuery.replace(/(是什么|怎么样了|怎么样|呢|吗|是哪轮|是哪一轮)$/u, '').trim();
      if (last) {
        const literalTerms = [...new Set(lastQuery.toLowerCase().match(/[a-z0-9_.-]+|[\u4e00-\u9fff]+/g) ?? [])];
        if (literalTerms.length >= 2) {
          const literalHits = visible.filter((record) => {
            const text = record.text.toLowerCase();
            return literalTerms.every((term) => text.includes(term));
          });
          if (literalHits.length > 0) {
            return {
              query,
              route: `literal${routeSuffix}`,
              layers: ['literal'],
              facet: {},
              fused: orderHits(literalHits, true).slice(0, topK).map((record) => ({
                turn: record.turn,
                seqStart: record.seqStart,
                seqEnd: record.seqEnd,
                score: 1,
                sources: { literal: 1 },
              })),
            };
          }
        }
      }
      if (last && /^[\u4e00-\u9fff]{4,}$/u.test(lastQuery)) {
        const mid = Math.ceil(lastQuery.length / 2);
        const left = lastQuery.slice(0, mid);
        const right = lastQuery.slice(mid);
        const concept = visible.filter((record) => {
          const text = record.text;
          return text.includes(left) && text.includes(right);
        });
        if (concept.length > 0) {
          return {
            query,
            route: `concept${routeSuffix}`,
            layers: ['concept'],
            facet: {},
            fused: orderHits(concept, true).slice(0, topK).map((record) => ({
              turn: record.turn,
              seqStart: record.seqStart,
              seqEnd: record.seqEnd,
              score: 1,
              sources: { concept: 1 },
            })),
          };
        }
      }
      if (last && lastQuery.length >= 2) {
        const textHits = visible.filter((record) => record.text.toLowerCase().includes(lastQuery.toLowerCase()));
        if (textHits.length > 0) {
          return {
            query,
            route: `phrase${routeSuffix}`,
            layers: ['phrase'],
            facet: {},
            fused: orderHits(textHits, true).slice(0, topK).map((record) => ({
              turn: record.turn,
              seqStart: record.seqStart,
              seqEnd: record.seqEnd,
              score: 1,
              sources: { phrase: 1 },
            })),
          };
        }
      }
      const normalized = cleanQuery.toLowerCase();
      const exact = /\.[a-z0-9]{2,5}\b/i.test(cleanQuery)
        ? visible.filter((record) => record.text.toLowerCase().includes(normalized))
        : [];
      if (exact.length > 0 && exact.length <= 50) {
        return {
          query,
          route: `phrase${routeSuffix}`,
          layers: ['phrase'],
          facet: {},
          fused: orderHits(exact, last).slice(0, topK).map((record) => ({
            turn: record.turn,
            seqStart: record.seqStart,
            seqEnd: record.seqEnd,
            score: 1,
            sources: { phrase: 1 },
          })),
        };
      }

      const terms = cleanQuery.split(/\s+/).map((term) => term.trim().toLowerCase()).filter(Boolean);
      if (terms.length >= 2) {
        const both = visible.filter((record) => {
          const text = record.text.toLowerCase();
          return terms.every((term) => text.includes(term));
        });
        if (both.length > 0 && both.length <= 50) {
          return {
            query,
            route: `and${routeSuffix}`,
            layers: ['and'],
            facet: {},
            fused: orderHits(both, last).slice(0, topK).map((record) => ({
              turn: record.turn,
              seqStart: record.seqStart,
              seqEnd: record.seqEnd,
              score: 1,
              sources: { and: 1 },
            })),
          };
        }
      }

      const keyword = asOfFilter(bm25.search(lastQuery || cleanQuery, {
        topK: last ? visible.length : topK * 5,
        minCoverage: last ? 0.8 : 0.6,
      }), asOf);
      if (keyword.length > 0 && keyword[0].score >= 2) {
        return {
          query,
          route: `bm25${routeSuffix}`,
          layers: ['bm25'],
          facet: {},
          fused: orderHits(keyword, last).slice(0, topK).map((hit) => ({
            turn: hit.turn,
            seqStart: hit.seqStart,
            seqEnd: hit.seqEnd,
            score: hit.score,
            sources: { bm25: hit.score, coverage: hit.coverage },
          })),
        };
      }

      if (queryVector !== null) {
        const semantic = asOfFilter(vectorIndex.search(queryVector, { topK: topK * 5 }), asOf);
        if (semantic.length > 0 && semantic[0].score >= (last ? 0.65 : 0.55)) {
          return {
            query,
            route: `vector${routeSuffix}`,
            layers: ['vector'],
            facet: {},
            fused: orderHits(semantic, last).slice(0, topK).map((hit) => ({
              turn: hit.turn,
              seqStart: hit.seqStart,
              seqEnd: hit.seqEnd,
              score: hit.score,
              sources: { vector: hit.score },
            })),
          };
        }
      }

      if (/后来|经过|总结|发生了什么|时间线/.test(cleanQuery)) {
        const summary = asOfFilter(summaryBm25.search(cleanQuery, { topK: topK * 3, minCoverage: 0.5 }), asOf);
        if (summary.length > 0) {
          return {
            query,
            route: `summary${routeSuffix}`,
            layers: ['summary'],
            facet: {},
            fused: orderHits(summary, last).slice(0, topK).map((hit) => ({
              turn: hit.turn,
              seqStart: hit.seqStart,
              seqEnd: hit.seqEnd,
              score: hit.score,
              sources: { summary: hit.score },
            })),
          };
        }
      }

      return { query, route: 'empty', layers: [], facet: {}, fused: [] };
    },
  };
}

export function summaryIndex(tree) {
  return new BM25Index().build(tree.nodes
    .filter((node) => node.level !== 'turn')
    .map((node) => ({
      turn: node.firstTurn,
      firstTurn: node.firstTurn,
      lastTurn: node.lastTurn,
      seqStart: node.seqStart,
      seqEnd: node.seqEnd,
      text: node.summary,
    })));
}
