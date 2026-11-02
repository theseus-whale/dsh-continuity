/**
 * Resolve a facet query to loadable seqs.
 * The plugin still uses the normal `continuity.load` path; this only turns
 * alias/query facets into seqs and ranges.
 */
import fs from 'node:fs';
import { queryFacets } from './index.mjs';
import { loadIndex } from './store.mjs';
import { aliasFacets } from './schema.mjs';

export function loadFacetQuery(query, {
  indexFile,
  topK = 20,
  maxSeqs = 200,
} = {}) {
  if (typeof indexFile !== 'string' || indexFile.length === 0) {
    throw new Error('facet load: indexFile is required');
  }
  const index = loadIndex(indexFile);
  const result = queryFacets(index, query, { topK });
  const seqs = [];
  for (const match of result.matches) {
    const start = Number(match.seqStart);
    const end = Number(match.seqEnd);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) continue;
    for (let seq = start; seq <= end && seqs.length < maxSeqs; seq += 1) seqs.push(seq);
    if (seqs.length >= maxSeqs) break;
  }
  return {
    query,
    facets: aliasFacets(query),
    ranges: result.ranges,
    seqs,
    truncated: seqs.length >= maxSeqs,
  };
}

