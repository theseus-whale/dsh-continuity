#!/usr/bin/env node
/**
 * Extract-bench harness. Fixtures: JSONL with {text, language?, entities:[...]}.
 * Provider: a JS module exporting extract(text, route) or {zh,en,mixed} functions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createExtractionCore } from '../src/memory/extraction-core.mjs';
import { scoreEntities, aggregateScores } from '../src/memory/extraction-score.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const fixturesPath = argOf('--fixtures');
const providerPath = argOf('--provider');
const outPath = argOf('--out') ?? null;
if (!fixturesPath || !providerPath) {
  console.error('usage: node bin/memory-extraction-bench.mjs --fixtures dev.jsonl --provider provider.mjs [--out result.json]');
  process.exit(2);
}
const mod = await import(pathToFileURL(path.resolve(providerPath)).href);
const provider = mod.default ?? mod.provider ?? mod;
const providers = typeof provider === 'function'
  ? { zh: provider, en: provider, mixed: provider }
  : provider;
const core = createExtractionCore({ providers });
const fixtures = fs.readFileSync(fixturesPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line.replace(/^\uFEFF/, '')));
const rows = [];
for (const fixture of fixtures) {
  const result = core.extract(fixture.text);
  const predicted = result.ok ? result.entities : [];
  const score = scoreEntities(predicted, fixture.entities ?? []);
  rows.push({
    text: fixture.text,
    language: result.language,
    ok: result.ok,
    reason: result.reason ?? null,
    predicted: predicted.length,
    expected: fixture.entities?.length ?? 0,
    score,
  });
}
const byLanguage = {};
for (const language of [...new Set(rows.map((row) => row.language))]) {
  byLanguage[language] = aggregateScores(rows.filter((row) => row.language === language).map((row) => row.score));
}
const output = {
  fixtures: rows.length,
  failed: rows.filter((row) => !row.ok).length,
  aggregate: aggregateScores(rows.map((row) => row.score)),
  byLanguage,
  rows,
};
if (outPath) fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(JSON.stringify({ fixtures: output.fixtures, failed: output.failed, aggregate: output.aggregate, byLanguage }, null, 2));
