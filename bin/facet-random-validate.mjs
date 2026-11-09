#!/usr/bin/env node
/**
 * Random-facet sanity check.
 *
 * Positive labels are explicit mechanics words (rule-derived, not human gold).
 * The detector is intentionally allowed to use the same signal; this verifies
 * that the old all-"无" collapse is gone, not that the rule generalizes.
 */
import fs from 'node:fs';
import { detectRandom } from '../src/facets/random.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const input = argOf('--input');
if (!input) {
  console.error('usage: node bin/facet-random-validate.mjs --input rows.jsonl');
  process.exit(2);
}
const rows = fs.readFileSync(input, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const STRONG = ['掷骰', '骰子', '骰', 'd20', '检定', '抽卡'];
const isPositiveLabel = (text) => STRONG.some((hint) => String(text ?? '').toLowerCase().includes(hint));
let positive = 0;
let hit = 0;
let falsePositive = 0;
let negative = 0;
const examples = [];
for (const row of rows) {
  const label = isPositiveLabel(row.text) ? '有' : '无';
  const predicted = detectRandom(row.text);
  if (label === '有') positive += 1;
  else negative += 1;
  if (label === '有' && predicted.value === '有') hit += 1;
  if (label === '无' && predicted.value === '有') falsePositive += 1;
  if (label === '有') examples.push({ turn: row.turn, hits: predicted.hits });
}
console.log(JSON.stringify({
  total: rows.length,
  positive,
  negative,
  recall: positive === 0 ? 0 : hit / positive,
  falsePositive,
  precision: hit + falsePositive === 0 ? 0 : hit / (hit + falsePositive),
  positiveRate: rows.length === 0 ? 0 : positive / rows.length,
  examples: examples.slice(0, 10),
}, null, 2));
