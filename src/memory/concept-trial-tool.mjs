/**
 * concept_trial — score a proposed A label/description against real turns
 * before writing concepts.md.
 *
 * It is deliberately read-only and does not call an LLM. It embeds the
 * candidate description and the selected turns, compares the candidate with
 * the current top A score, and reports coverage/separation. A failed trial is
 * evidence for `review: abstain`, not a reason to write anyway.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sessionDir } from './persona.mjs';
import { loadIndexJsonl } from './bc-index.mjs';
import { embedTexts as defaultEmbed } from '../facets/embedding.mjs';

function readTurns(file) {
  const map = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const item = JSON.parse(line);
    if (Number.isInteger(item.turn) && typeof item.text === 'string') map.set(item.turn, item.text);
  }
  return map;
}

function norm(vector) {
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / length);
}

function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) dot += a[i] * b[i];
  return dot;
}

function existingTop(row) {
  return Number(Object.values(row.conceptScores ?? {}).sort((a, b) => Number(b) - Number(a))[0] ?? 0);
}

export function createConceptTrialTool({ home, embed = defaultEmbed } = {}) {
  return {
    name: 'concept_trial',
    description: 'Read-only trial for a proposed A concept. It embeds the proposed description and real turns, then reports target coverage, target mean, non-target mean, separation, and whether the candidate beats the current top A. Use before memory_repair concept_add/update; a failed trial should lead to review: abstain or a revised candidate, not a write.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        label: { type: 'string', description: 'Proposed A label.' },
        description: { type: 'string', description: 'Short prototype definition, not a turn summary.' },
        startTurn: { type: 'integer', description: 'Optional target start turn; defaults to the last 12 indexed turns.' },
        endTurn: { type: 'integer', description: 'Optional target end turn; defaults to the last indexed turn.' },
      },
      required: ['label', 'description'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    async execute(args = {}, exec = {}) {
      const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id;
      if (!sessionId) throw new Error('concept_trial: no current session id');
      const session = String(sessionId);
      const label = String(args.label ?? '').trim();
      const description = String(args.description ?? '').trim();
      if (!label || !description) throw new Error('concept_trial: label and description are required');
      const dir = sessionDir(session, home);
      const turnsFile = path.join(dir, 'turns.jsonl');
      const indexFile = path.join(dir, 'bc-index.jsonl');
      if (!fs.existsSync(turnsFile)) throw new Error('concept_trial: turns.jsonl is missing');
      if (!fs.existsSync(indexFile)) throw new Error('concept_trial: bc-index.jsonl is missing');

      const turns = readTurns(turnsFile);
      const rows = loadIndexJsonl(indexFile).filter((row) => turns.has(row.turn));
      if (rows.length === 0) throw new Error('concept_trial: no indexed turns with text');
      const last = rows.at(-1).turn;
      const start = Number.isInteger(args.startTurn) ? args.startTurn : Math.max(rows[0].turn, last - 11);
      const end = Number.isInteger(args.endTurn) ? args.endTurn : last;
      if (start > end) throw new Error('concept_trial: startTurn must be <= endTurn');
      const target = rows.filter((row) => row.turn >= start && row.turn <= end);
      const other = rows.filter((row) => row.turn < start || row.turn > end);
      if (target.length === 0) throw new Error('concept_trial: target window has no turns');

      const texts = rows.map((row) => turns.get(row.turn));
      const vectors = await embed([description, ...texts]);
      const candidate = norm(vectors[0]);
      const byTurn = new Map(rows.map((row, index) => [row.turn, norm(vectors[index + 1])]));
      const scores = rows.map((row) => ({ row, score: cosine(candidate, byTurn.get(row.turn)) }));
      const targetScores = scores.filter((item) => item.row.turn >= start && item.row.turn <= end);
      const otherScores = scores.filter((item) => item.row.turn < start || item.row.turn > end);
      const mean = (items) => items.length === 0 ? 0 : items.reduce((sum, item) => sum + item.score, 0) / items.length;
      const targetMean = mean(targetScores);
      const otherMean = mean(otherScores);
      const separation = targetMean - otherMean;
      const targetTop1 = targetScores.filter((item) => item.score > existingTop(item.row)).length;
      const coverage = targetTop1 / targetScores.length;
      const passed = targetTop1 >= Math.min(2, targetScores.length) && separation >= 0.02;
      return JSON.stringify({
        ok: true,
        label,
        range: [start, end],
        turns: targetScores.length,
        targetTop1,
        coverage: Number(coverage.toFixed(4)),
        targetMean: Number(targetMean.toFixed(4)),
        otherMean: Number(otherMean.toFixed(4)),
        separation: Number(separation.toFixed(4)),
        passed,
        note: passed
          ? 'candidate is separable on this window; a write can be considered'
          : 'candidate is not separable; revise it, merge/update an existing A, or abstain',
      });
    },
  };
}
