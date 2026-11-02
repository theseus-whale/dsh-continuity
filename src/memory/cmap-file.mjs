/**
 * C map file: user term -> B generic concepts (+ optional K / minB / summary).
 *
 * Old:
 *   跑团 => 游戏 / 故事 / 对话
 * New:
 *   跑团 => B:游戏/故事/剧情/对话 | K:example-name | minB:2 | 摘要：...
 *
 * One line per term; `#` starts a comment.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function defaultCMapPath(home = process.env.USERPROFILE ?? process.env.HOME ?? os.homedir()) {
  return path.join(home, '.dsh', 'continuity', 'cmap.md');
}

function splitTerms(text) {
  return String(text ?? '').split(/[\/,，、]/).map((word) => word.trim()).filter(Boolean);
}

function defaultParseError({ line, text, message }) {
  try {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();
    const file = path.join(home, '.dsh', 'continuity', 'gate-errors.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({
      at: new Date().toISOString(),
      code: 'cmap-parse-failed',
      line,
      text: String(text ?? '').slice(0, 40),
      message,
    }) + '\n', 'utf8');
  } catch { /* parse logging must not break loading */ }
}

export function parseCMapText(text, { onError = defaultParseError } = {}) {
  const entries = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const match = line.match(/^(.+?)\s*(?:=>|->|→)\s*(.+)$/);
    if (!match) {
      onError?.({ line: index + 1, text: raw, message: 'missing =>' });
      continue;
    }
    const term = match[1].trim();
    if (!term) {
      onError?.({ line: index + 1, text: raw, message: 'empty term' });
      continue;
    }

    let body = match[2].trim();
    let summary = '';
    const summaryMarker = body.lastIndexOf('摘要：') >= 0 ? '摘要：' : '摘要:';
    const summaryAt = body.lastIndexOf(summaryMarker);
    if (summaryAt >= 0) {
      summary = body.slice(summaryAt + summaryMarker.length).trim();
      body = body.slice(0, summaryAt).trim();
    }

    let generic = [];
    let keywords = [];
    let minB = 0;
    let limit = 20;
    if (/(?:^|\|)\s*B\s*[:：]/i.test(body)) {
      for (const segment of body.split(/\s*\|\s*/)) {
        const item = segment.trim();
        if (!item) continue;
        const pair = item.match(/^([A-Za-z]+)\s*[:：]\s*(.*)$/);
        if (!pair) continue;
        const key = pair[1].toLowerCase();
        const value = pair[2].trim();
        if (key === 'b') generic = splitTerms(value);
        else if (key === 'k') keywords = splitTerms(value);
        else if (key === 'minb') {
          const parsed = Number.parseInt(value, 10);
          if (Number.isInteger(parsed) && parsed >= 0) minB = parsed;
        } else if (key === 'limit') {
          const parsed = Number.parseInt(value, 10);
          if (Number.isInteger(parsed) && parsed > 0) limit = parsed;
        }
        // Unknown segments are ignored on purpose.
      }
    } else {
      generic = splitTerms(body);
    }

    if (generic.length === 0) {
      onError?.({ line: index + 1, text: raw, message: 'empty B list' });
      continue;
    }
    entries.push({ term, generic, keywords, minB, limit, summary });
  }
  return entries;
}

export function loadCMapEntries(file = defaultCMapPath(), { onError = defaultParseError } = {}) {
  try {
    return parseCMapText(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''), { onError });
  } catch {
    return [];
  }
}
