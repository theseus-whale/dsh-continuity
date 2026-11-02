/**
 * Facet-aware fold planning.
 *
 * Produces candidate contiguous ranges for the high-trigger compaction path.
 * The engine still decides policy; this module only ranks old ranges and
 * protects high-relevance current-topic turns.
 */
import { facetScore } from './sensitivity.mjs';
import fs from 'node:fs';
import path from 'node:path';

export function loadFacetFoldFile(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = Array.isArray(raw?.entries) ? raw.entries : [];
  const query = raw?.query ?? {};
  const idf = new Map(Array.isArray(raw?.idf) ? raw.idf : []);
  return { entries, query, idf };
}

export function defaultFacetFoldFile({
  home = process.env.USERPROFILE ?? process.env.HOME,
} = {}) {
  return path.join(String(home ?? ''), '.dsh', 'continuity', 'facet-fold.json');
}

export function planFacetFold(entries, {
  query = {},
  idf = null,
  recentTurns = 20,
  budgetTokens = 20000,
  tokensBySeq = new Map(),
  protectScore = 0.5,
} = {}) {
  if (entries.length === 0) return { ranges: [], protected: [], seqs: [], tokens: 0 };
  const latestTurn = Math.max(...entries.map((entry) => entry.turn));
  const protectedEntries = [];
  const candidates = [];
  for (const entry of entries) {
    const score = facetScore(entry.facets, query, idf).score;
    const old = latestTurn - entry.turn > recentTurns;
    if (score >= protectScore || !old) {
      protectedEntries.push({ turn: entry.turn, seqStart: entry.seqStart, seqEnd: entry.seqEnd, score });
      continue;
    }
    candidates.push({ ...entry, score, priority: (1 - Math.min(1, score)) * (latestTurn - entry.turn) });
  }
  candidates.sort((a, b) => b.priority - a.priority);

  const ranges = [];
  let used = 0;
  const usedSeqs = new Set();
  for (const entry of candidates) {
    const seqs = [];
    const start = Number(entry.seqStart);
    const end = Number(entry.seqEnd);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) continue;
    let tokens = 0;
    for (let seq = start; seq <= end; seq += 1) {
      if (usedSeqs.has(seq)) continue;
      const next = Number(tokensBySeq.get?.(seq) ?? 0);
      if (used + tokens + next > budgetTokens) break;
      seqs.push(seq);
      tokens += next;
    }
    if (seqs.length === 0) continue;
    for (const seq of seqs) usedSeqs.add(seq);
    used += tokens;
    ranges.push({
      seqStart: seqs[0],
      seqEnd: seqs[seqs.length - 1],
      turns: 1,
      tokens,
      score: entry.score,
      priority: entry.priority,
    });
    if (used >= budgetTokens) break;
  }
  return {
    ranges,
    protected: protectedEntries,
    seqs: [...usedSeqs].sort((a, b) => a - b),
    tokens: used,
  };
}
