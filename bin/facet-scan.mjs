#!/usr/bin/env node
/**
 * Incremental facet scan CLI.
 *
 * node bin/facet-scan.mjs --input rows.jsonl --dir .facet --query 跑团
 *
 * rows: { turn, seqStart, seqEnd, text?, facets? }
 * Files: facet-index.json, facet-cursor.json, facet-residual.jsonl
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildFacetIndex, queryFacets, indexStats } from '../src/facets/index.mjs';
import { emptyCursor, scanRows, residualCount } from '../src/facets/scanner.mjs';
import { loadCursor, loadIndex, saveCursor, saveIndex } from '../src/facets/store.mjs';
import { classifierExtractor, deserializeClassifier } from '../src/facets/classifier.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const input = argOf('--input');
const dir = argOf('--dir') ?? '.facet';
const query = argOf('--query') ?? '跑团';
const modelFile = argOf('--model');
if (!input) {
  console.error('usage: node bin/facet-scan.mjs --input rows.jsonl --dir .facet --query 跑团 [--model facet-model.json]');
  process.exit(2);
}
const extract = modelFile !== undefined
  ? classifierExtractor(deserializeClassifier(JSON.parse(fs.readFileSync(modelFile, 'utf8'))))
  : undefined;
const rows = fs.readFileSync(input, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
fs.mkdirSync(dir, { recursive: true });
const indexFile = path.join(dir, 'facet-index.json');
const cursorFile = path.join(dir, 'facet-cursor.json');
const residualFile = path.join(dir, 'facet-residual.jsonl');

const previous = fs.existsSync(indexFile) ? loadIndex(indexFile) : { entries: [] };
const cursor = loadCursor(cursorFile) ?? emptyCursor();
const scanResult = scanRows(rows, cursor, extract === undefined ? {} : { extract });
const merged = [...previous.entries, ...scanResult.entries];
const index = buildFacetIndex(merged);
saveIndex(indexFile, index);
saveCursor(cursorFile, scanResult.cursor);
fs.writeFileSync(residualFile, (scanResult.cursor.residual ?? []).map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');

const result = queryFacets(index, query, { topK: 50 });
console.log(JSON.stringify({
  stats: indexStats(index),
  scanned: scanResult.entries.length,
  residual: residualCount(scanResult.cursor),
  query: { name: result.query, facets: result.facets },
  matchCount: result.matches.length,
  ranges: result.ranges,
}, null, 2));
