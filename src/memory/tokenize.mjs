/** Shared tokenizer for BM25. */
export function tokenize(text) {
  const raw = String(text ?? '').toLowerCase();
  const words = raw.match(/[a-z0-9_]+/g) ?? [];
  const chinese = [...raw.replace(/[^\u4e00-\u9fff]/g, '')];
  const bigrams = [];
  for (let i = 0; i + 1 < chinese.length; i += 1) bigrams.push(chinese[i] + chinese[i + 1]);
  return [...words, ...bigrams];
}
