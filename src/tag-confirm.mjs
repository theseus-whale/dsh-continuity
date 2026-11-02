/**
 * New-tag policy for the strict `TAG: NEW:<word>` interface.
 *
 * An unknown word without NEW: is not a tag request; it is a typo or an
 * attempt to let the model confirm itself. The gate must reject it.
 */

/** Split only on em/en dash; ASCII hyphen is part of F-35 / COVID-19. */
export function tagTokenFromDeclaration(declaration) {
  return String(declaration ?? '')
    .replace(/^TAG\s*[:：]\s*/i, '')
    .split(/[—–]/)[0]
    .trim();
}

/** Return the explicit NEW: word (quotes stripped), or null. */
export function splitNewToken(token) {
  const key = String(token ?? '').trim();
  const hit = /^NEW\s*[:：]\s*(.+)$/i.exec(key);
  return hit === null ? null : tagWordFromToken(hit[1]);
}

/** Strip wrapping quotes so evidence/near-label use the word itself. */
export function tagWordFromToken(token) {
  const key = String(token ?? '').trim();
  const wrap = /^["“「'‘](.*)["”」'’]$/.exec(key);
  return wrap !== null ? wrap[1].trim() : key;
}

function isTagLine(line) {
  return /^\s*TAG\s*[:：]/i.test(line);
}

/**
 * The word must appear in the user's message or the assistant body, not only
 * in the TAG line or in the gate question itself.
 */
export function hasWordEvidence({ userText = '', assistantText = '', word = '' } = {}) {
  const needle = String(word ?? '').trim().toLowerCase();
  if (needle.length === 0) return false;
  const visible = (text) => String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => !isTagLine(line) && !/^\s*\[(?:闸|gate|peer)/.test(line))
    .join('\n')
    .toLowerCase();
  return visible(userText).includes(needle) || visible(assistantText).includes(needle);
}

/** Levenshtein distance, used only for near-duplicate label names. */
export function editDistance(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let prev = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      next[j] = Math.min(prev[j] + 1, next[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = next;
  }
  return prev[right.length];
}

/** Return the first existing label within edit distance 1, or null. */
export function findNearLabel(labels, word) {
  const target = String(word ?? '').trim();
  if (target.length === 0) return null;
  for (const item of Array.isArray(labels) ? labels : []) {
    const label = String(item?.label ?? '').trim();
    if (label.length === 0 || label === target) continue;
    if (editDistance(target, label) <= 1) return item;
  }
  return null;
}
