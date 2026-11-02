/** Shared chatter/register score (not a topic concept). */
import { extractKeywords } from './bc-recall.mjs';

const CJK = /[\u4e00-\u9fff]{2,6}/g;
const FUNCTION = /[了的着吗呢吧啊]/g;

export function buildDf(texts) {
  const df = new Map();
  for (const text of texts) {
    const tokens = [...String(text ?? '').matchAll(CJK)].map((match) => match[0]);
    for (const token of new Set(tokens)) df.set(token, (df.get(token) ?? 0) + 1);
  }
  return df;
}

export function chatterScore(text, df = new Map()) {
  const source = String(text ?? '');
  const tokens = [...source.matchAll(CJK)].map((match) => match[0]);
  const proper = tokens.filter((token) => (df.get(token) ?? 0) <= 3).length;
  const properDensity = tokens.length ? proper / tokens.length : 0;
  const fnDensity = (source.match(FUNCTION) ?? []).length / Math.max(1, source.length);
  const keywordSparse = extractKeywords(source, { limit: 10 }).length < 3 ? 1 : 0;
  const quotes = (source.match(/[「」“”"——]/g) ?? []).length;
  return 0.30 * (source.length < 60 ? 1 : 0)
    + 0.25 * Math.min(1, properDensity)
    + 0.20 * Math.min(1, fnDensity * 20)
    + 0.15 * keywordSparse
    + 0.10 * (quotes > 0 ? 1 : 0);
}
