/**
 * Special keywords are exact names the user wants matched: project names,
 * handles, product names, etc.
 *
 * They are not B generic concepts and cannot be decomposed into them.
 * The fallback is empty: a new session should not inherit anyone's names.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_SPECIAL_KEYWORDS = Object.freeze([]);

export function defaultSpecialKeywordsPath(home = process.env.USERPROFILE ?? process.env.HOME ?? os.homedir()) {
  return path.join(home, '.dsh', 'continuity', 'keywords.md');
}

export function parseSpecialKeywords(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line.length > 0 && !line.startsWith('<!--'));
}

export function loadSpecialKeywords(file = defaultSpecialKeywordsPath()) {
  try {
    const words = parseSpecialKeywords(fs.readFileSync(file, 'utf8'));
    return words.length > 0 ? words : [...DEFAULT_SPECIAL_KEYWORDS];
  } catch {
    return [...DEFAULT_SPECIAL_KEYWORDS];
  }
}

function isLatin(word) {
  return /^[a-z0-9 _.-]+$/i.test(word);
}

export function matchSpecialKeywords(text, keywords = DEFAULT_SPECIAL_KEYWORDS) {
  const source = String(text ?? '');
  const found = [];
  for (const raw of keywords) {
    const keyword = String(raw ?? '').trim();
    if (!keyword) continue;
    let hit = false;
    if (isLatin(keyword)) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      hit = new RegExp(`(^|[^a-z0-9_])${escaped}(?=$|[^a-z0-9_])`, 'i').test(source);
    } else {
      hit = source.includes(keyword);
    }
    if (hit) found.push(keyword);
  }
  return [...new Set(found)];
}

export function withSpecialKeywords(text, keywords = []) {
  return [...new Set([...keywords, ...matchSpecialKeywords(text)])];
}
