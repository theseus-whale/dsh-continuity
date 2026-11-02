/**
 * B+C panel state: counts of B generic labels in the pointer index.
 * Read-only; no session access.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadIndexJsonl } from './bc-index.mjs';
import { DEFAULT_C_SEED } from './bc-recall.mjs';
import { defaultCMapPath, loadCMapEntries } from './cmap-file.mjs';
import { defaultSpecialKeywordsPath, loadSpecialKeywords } from './special-keywords.mjs';
import { loadConcepts } from './concepts-file.mjs';

export function buildBCPanelState({ file = null, keywordsFile = null, cmapFile = null, conceptsFile = null, home = process.env.USERPROFILE ?? process.env.HOME ?? '' } = {}) {
  const indexFile = file ?? path.join(home, '.dsh', 'continuity', 'bc-index.jsonl');
  if (!fs.existsSync(indexFile)) {
    return { available: false, file: indexFile, error: 'bc-index.jsonl not found', generatedAt: new Date().toISOString() };
  }
  const records = loadIndexJsonl(indexFile);
  const turns = records.map((record) => record.turn).filter((turn) => Number.isInteger(turn)).sort((a, b) => a - b);
  const stat = fs.statSync(indexFile);
  const firstTurn = turns.length > 0 ? turns[0] : null;
  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const keywordsPath = keywordsFile ?? defaultSpecialKeywordsPath(home);
  let specialKeywords;
  if (fs.existsSync(keywordsPath)) {
    const raw = fs.readFileSync(keywordsPath, 'utf8');
    const hasWords = raw.split(/\r?\n/).some((line) => {
      const text = line.trim();
      return text.length > 0 && !text.startsWith('#');
    });
    specialKeywords = hasWords ? loadSpecialKeywords(keywordsPath) : [];
  } else {
    specialKeywords = keywordsFile ? [] : loadSpecialKeywords();
  }
  const aLabels = loadConcepts(conceptsFile ?? path.join(home, '.dsh', 'continuity', 'concepts.md'));
  const knownConcepts = new Set(aLabels.map((row) => row.label));
  const counts = new Map();
  const kCounts = new Map();
  const cCounts = new Map();
  const cFileEntries = loadCMapEntries(cmapFile ?? defaultCMapPath(home));
  const cMeta = new Map();
  for (const entry of DEFAULT_C_SEED) {
    cMeta.set(entry.term, { generic: entry.generic, keywords: [], minB: 0, summary: '' });
  }
  for (const entry of cFileEntries) cMeta.set(entry.term, entry);
  const cTerms = [...cMeta.keys()];
  let weak = 0;
  for (const record of records) {
    if (record.status === 'weak') weak += 1;
    for (const concept of record.generic ?? []) {
      if (knownConcepts.has(concept)) counts.set(concept, (counts.get(concept) ?? 0) + 1);
    }
    for (const term of cTerms) {
      if ((record.terms ?? []).includes(term)) cCounts.set(term, (cCounts.get(term) ?? 0) + 1);
    }
    const words = new Set((record.keywords ?? []).map((word) => String(word).toLowerCase()));
    for (const keyword of specialKeywords) {
      if (words.has(keyword.toLowerCase())) kCounts.set(keyword, (kCounts.get(keyword) ?? 0) + 1);
    }
  }
  const labels = [...counts.entries()]
    .map(([label, turns]) => ({ label, turns }))
    .sort((a, b) => b.turns - a.turns || a.label.localeCompare(b.label));
  const kLabels = [...kCounts.entries()]
    .map(([label, turns]) => ({ label, turns }))
    .sort((a, b) => b.turns - a.turns || a.label.localeCompare(b.label));
  const cLabels = [...cCounts.entries()]
    .map(([label, turns]) => {
      const meta = cMeta.get(label) ?? {};
      return {
        label,
        turns,
        concepts: meta.generic ?? [],
        keywords: meta.keywords ?? [],
        minB: meta.minB ?? 0,
        limit: meta.limit ?? 20,
        summary: meta.summary ?? '',
      };
    })
    .sort((a, b) => b.turns - a.turns || a.label.localeCompare(b.label));
  return {
    available: true,
    file: indexFile,
    totalTurns: records.length,
    firstTurn,
    lastTurn,
    updatedAt: stat.mtime.toISOString(),
    weakTurns: weak,
    labels,
    kLabels,
    cLabels,
    aLabels,
    aTopics: aLabels.filter((row) => row.kind !== 'workflow'),
    aWorkflow: aLabels.filter((row) => row.kind === 'workflow'),
    generatedAt: new Date().toISOString(),
  };
}
