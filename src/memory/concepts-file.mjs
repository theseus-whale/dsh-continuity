/**
 * A-layer concepts (display only).
 *
 * Format: name | description | optional coverage | kind
 * `kind` is `topic` (default) or `workflow`; workflow concepts are excluded
 * from the default A browse but remain valid labels.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function defaultConceptsPath(home = process.env.USERPROFILE ?? process.env.HOME ?? os.homedir()) {
  return path.join(home, '.dsh', 'continuity', 'concepts.md');
}

export function parseConcepts(text) {
  const rows = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const parts = line.split('|').map((part) => part.trim());
    if (parts.length < 2 || !parts[0] || !parts[1]) continue;
    const coverage = Number.parseInt(parts[2] ?? '', 10);
    const rawKind = String(parts[3] ?? '').trim().toLowerCase().replace(/^kind\s*=\s*/, '');
    rows.push({
      label: parts[0],
      description: parts[1],
      coverage: Number.isInteger(coverage) ? coverage : null,
      kind: rawKind === 'workflow' ? 'workflow' : 'topic',
    });
  }
  return rows;
}

export function loadConcepts(file = defaultConceptsPath()) {
  try {
    return parseConcepts(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return [];
  }
}
