/**
 * Query-side aliases for the literal layer.
 *
 * Format (one term per line):
 *   通知 => notification / post_notifications
 *   ...
 *
 * This file affects only the literal query path; it does not change the index,
 * B descriptors, or C/K data.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function defaultAliasesPath(home = process.env.USERPROFILE ?? process.env.HOME ?? os.homedir()) {
  return path.join(home, '.dsh', 'continuity', 'aliases.md');
}

export function parseAliases(text) {
  const aliases = new Map();
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const match = line.match(/^(.+?)\s*(?:=>|->|→)\s*(.+)$/);
    if (!match) continue;
    const term = match[1].trim();
    const values = match[2].split(/[\/,，、]/).map((word) => word.trim()).filter(Boolean);
    if (term && values.length > 0) aliases.set(term, values);
  }
  return aliases;
}

export function loadQueryAliases(file = defaultAliasesPath()) {
  try {
    return parseAliases(fs.readFileSync(file, 'utf8'));
  } catch {
    return new Map();
  }
}
