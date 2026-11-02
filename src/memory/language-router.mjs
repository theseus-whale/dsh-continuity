/**
 * Language router for zh / en / mixed messages.
 * Not a language detector replacement; deterministic and explainable.
 */
export function routeLanguage(text) {
  const source = String(text ?? '');
  const cjk = (source.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latin = (source.match(/[A-Za-z]/g) ?? []).length;
  const total = cjk + latin;
  if (total === 0) return { language: 'unknown', confidence: 0, cjk, latin };
  const zhRatio = cjk / total;
  const enRatio = latin / total;
  let language = 'mixed';
  if (cjk > 0 && latin > 0 && Math.min(zhRatio, enRatio) >= 0.1) language = 'mixed';
  else if (zhRatio >= 0.85) language = 'zh';
  else if (enRatio >= 0.85) language = 'en';
  return {
    language,
    confidence: +Math.max(zhRatio, enRatio).toFixed(2),
    zhRatio: +zhRatio.toFixed(2),
    enRatio: +enRatio.toFixed(2),
    cjk,
    latin,
  };
}

export function languageTag(text) {
  const route = routeLanguage(text);
  return `[${route.language}] ${text}`;
}
