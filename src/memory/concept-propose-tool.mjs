/**
 * concept_propose — read-only evidence pack for a candidate A.
 * It does not invent a label; it surfaces the target turns, distinctive terms,
 * and existing A names so the model can propose a candidate and then trial it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sessionDir } from './persona.mjs';

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'session', 'description', 'nconst', 'nconsole', 'const', 'await', 'json', 'string', 'true', 'false', 'null', 'run_code', 'user', 'assistant', 'content', 'text', 'turn', 'turns', 'tools']);

function readTurns(file) {
  const map = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const item = JSON.parse(line);
    if (Number.isInteger(item.turn) && typeof item.text === 'string') map.set(item.turn, item.text);
  }
  return map;
}

function terms(text) {
  const out = [];
  for (const match of String(text).matchAll(/[A-Za-z][A-Za-z0-9_.-]{2,}|[\u3400-\u9fff]{2,}/g)) {
    const term = match[0];
    if (STOP.has(term.toLowerCase())) continue;
    out.push(term);
  }
  return out;
}

export function createConceptProposeTool({ home } = {}) {
  return {
    name: 'concept_propose',
    description: 'Read-only evidence pack for a proposed A concept: target turns, distinctive terms, and existing A labels. It does not write or invent a concept. Use it to write 2-3 candidate prototypes, then call concept_trial before memory_repair.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        startTurn: { type: 'integer', description: 'Optional target start turn; defaults to the last 12 indexed turns.' },
        endTurn: { type: 'integer', description: 'Optional target end turn; defaults to the last indexed turn.' },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    async execute(args = {}, exec = {}) {
      const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id;
      if (!sessionId) throw new Error('concept_propose: no current session id');
      const dir = sessionDir(String(sessionId), home);
      const turnsFile = path.join(dir, 'turns.jsonl');
      if (!fs.existsSync(turnsFile)) throw new Error('concept_propose: turns.jsonl is missing');
      const turns = readTurns(turnsFile);
      const allTurns = [...turns.keys()].sort((a, b) => a - b);
      if (allTurns.length === 0) throw new Error('concept_propose: no turns');
      const start = Number.isInteger(args.startTurn) ? args.startTurn : Math.max(allTurns[0], allTurns.at(-1) - 11);
      const end = Number.isInteger(args.endTurn) ? args.endTurn : allTurns.at(-1);
      const selected = allTurns.filter((turn) => turn >= start && turn <= end);
      if (selected.length === 0) throw new Error('concept_propose: target window has no turns');
      const counts = new Map();
      for (const turn of selected) {
        for (const term of terms(turns.get(turn))) counts.set(term, (counts.get(term) ?? 0) + 1);
      }
      const distinctive = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12);
      const conceptsFile = path.join(dir, 'concepts.md');
      const aLabels = fs.existsSync(conceptsFile)
        ? fs.readFileSync(conceptsFile, 'utf8').split(/\r?\n/).map((line) => line.replace(/#.*$/, '').split('|')[0]?.trim()).filter(Boolean)
        : [];
      return JSON.stringify({
        ok: true,
        range: [start, end],
        turns: selected.length,
        sample: selected.slice(0, 3).map((turn) => ({ turn, text: turns.get(turn).slice(0, 500) })),
        distinctiveTerms: distinctive.map(([term, count]) => ({ term, count })),
        existingA: aLabels,
        note: 'write 2-3 short prototype candidates from the evidence, then concept_trial each; do not write without a passed trial',
      });
    },
  };
}
