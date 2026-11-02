/**
 * Skill preload: maps the active thread to skill files and builds the block
 * appended to the per-turn continuity message.
 *
 * Defaults: ~/.dsh/continuity/skills (override with DSH_SKILLS_DIR).
 *   index.json   { skills: [{ name, file, aliases, threads }], byKeyword }
 *   <name>.md    body with YAML frontmatter
 *
 * Matching is deterministic: a thread matches by thread id or tag alias.
 * No model, no heuristics.
 */
import { readFile, stat as statFile } from 'node:fs/promises';
import { join } from 'node:path';
import { continuityHome } from './threads-store.mjs';

export function skillsDir() {
  const override = process.env.DSH_SKILLS_DIR;
  return override !== undefined && override.length > 0
    ? override
    : join(continuityHome(), 'skills');
}

let cache = { index: null, bodies: new Map() };

export async function readSkillsIndex() {
  const file = join(skillsDir(), 'index.json');
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      skills: Array.isArray(parsed?.skills) ? parsed.skills : [],
      byKeyword: parsed?.byKeyword ?? {},
    };
  } catch {
    return { skills: [], byKeyword: {} };
  }
}

/** Skills whose `threads` contain any of the given ids/aliases. */
export function skillsForThreads(index, ids) {
  const set = new Set(ids.filter((x) => typeof x === 'string' && x.length > 0));
  return index.skills.filter((s) => Array.isArray(s.threads) && s.threads.some((t) => set.has(t)));
}

/** Skills matched by keywords that appear in the given text (byKeyword: word -> file). */
export function skillsForKeywords(index, text) {
  const hay = String(text ?? '');
  if (hay.length === 0) return [];
  const out = [];
  const seen = new Set();
  for (const [word, file] of Object.entries(index.byKeyword ?? {})) {
    if (!word || typeof file !== 'string') continue;
    if (!hay.includes(word)) continue;
    const entry = index.skills.find((candidate) => candidate.file === file || candidate.name === file);
    if (!entry || seen.has(entry.name)) continue;
    seen.add(entry.name);
    out.push(entry);
  }
  return out;
}

export function stripFrontmatter(raw) {
  // 去 BOM：PowerShell 写文件可能带 BOM，会让 frontmatter 判不出来。
  const text = String(raw ?? '').replace(/^\uFEFF/, '');
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return text;
  return text.slice(end + 4).replace(/^\s*/, '');
}

/** Read bodies (cached); truncate by a rough 4-chars-per-token budget. */
export async function buildSkillsBlock(entries, options = {}) {
  const maxTokens = Number.isInteger(options.maxTokens) ? options.maxTokens : 3000;
  if (entries.length === 0) return '';
  const parts = [];
  let budget = Math.max(200, maxTokens) * 4;
  for (const entry of entries) {
    const file = join(skillsDir(), entry.file);
    // 缓存带 mtime/size 校验：技能文件改了，下一轮就用新正文，不必重启。
    let stat = null;
    try { stat = await statFile(file); } catch { stat = null; }
    let cached = cache.bodies.get(file);
    if (cached !== undefined && stat !== null && (cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size)) {
      cached = undefined;
      cache.bodies.delete(file);
    }
    let body = cached?.body;
    if (body === undefined) {
      try {
        body = stripFrontmatter(await readFile(file, 'utf8')).trim();
      } catch {
        body = '';
      }
      cache.bodies.set(file, { body, mtimeMs: stat?.mtimeMs ?? 0, size: stat?.size ?? 0 });
    }
    if (!body) continue;
    if (budget - body.length < 0) {
      parts.push('…（预算不足，余下技能未载入）');
      break;
    }
    parts.push(body);
    budget -= body.length;
  }
  if (parts.length === 0) return '';
  const header = '[技能正文] 本次按线头与关键词自动载入，切换线头或关键词变化后自动换下。';
  return header + '\n\n' + parts.join('\n\n---\n\n');
}

export function clearSkillsCache() {
  cache = { index: null, bodies: new Map() };
}
