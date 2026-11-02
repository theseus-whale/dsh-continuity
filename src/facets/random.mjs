/**
 * Explicit random-signal detector.
 *
 * The last 100 turns contain no dice words, so a model trained only on them
 * collapses to "无". This detector is the positive-label source for random:
 * it is rule-based and deliberately narrow.
 */
export const RANDOM_HINTS = Object.freeze([
  '掷骰',
  '骰子',
  '骰',
  'd20',
  '检定',
  '抽卡',
]);

export function detectRandom(text) {
  const raw = String(text ?? '');
  const lower = raw.toLowerCase();
  const hits = RANDOM_HINTS.filter((hint) => lower.includes(hint));
  const dice = lower.match(/(?:^|[^a-z0-9])d\d{1,3}(?![a-z0-9])/g) ?? [];
  const getRandom = lower.includes('get-random');
  if (dice.length > 0) hits.push('dN');
  if (getRandom) hits.push('get-random');
  return { value: hits.length > 0 ? '有' : '无', hits: [...new Set(hits)] };
}
