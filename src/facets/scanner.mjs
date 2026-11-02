/**
 * Incremental scanner. It advances a seq cursor and queues unknowns; it never
 * blocks the cursor waiting for a schema answer.
 */
import { normalizeFacets } from './schema.mjs';
import { extractFacets } from './extract.mjs';

export function emptyCursor(schemaVersion = 1) {
  return { schemaVersion, lastSeq: -1, residual: [] };
}

export function scanRows(rows, cursor = emptyCursor(), { extract = extractFacets } = {}) {
  const state = {
    schemaVersion: cursor.schemaVersion ?? 1,
    lastSeq: Number.isInteger(cursor.lastSeq) ? cursor.lastSeq : -1,
    residual: Array.isArray(cursor.residual) ? [...cursor.residual] : [],
  };
  const entries = [];
  for (const row of [...rows].sort((a, b) => a.seqStart - b.seqStart)) {
    if (row.seqStart <= state.lastSeq) continue;
    const extracted = row.facets !== undefined
      ? { facets: normalizeFacets(row.facets), evidence: {}, unknown: false }
      : extract(row.text ?? '');
    const facets = extracted.facets ?? {};
    const unknown = extracted.unknown === true || Object.keys(facets).length === 0;
    if (unknown) state.residual.push({ seqStart: row.seqStart, seqEnd: row.seqEnd, turn: row.turn });
    entries.push({ turn: row.turn, seqStart: row.seqStart, seqEnd: row.seqEnd, facets, unknown });
    state.lastSeq = Math.max(state.lastSeq, row.seqEnd);
  }
  return { cursor: state, entries };
}

export function residualCount(cursor) {
  return Array.isArray(cursor?.residual) ? cursor.residual.length : 0;
}
