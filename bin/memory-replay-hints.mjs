#!/usr/bin/env node
/**
 * Prequential hint replay: turn 1 -> end.
 * At each turn, only prior turns are visible; if the current text mentions an
 * alias, ask buildLoadHint and record every popup.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readEventLog } from '../src/memory/event-log.mjs';
import { buildLoadHint } from '../src/facets/panel.mjs';
import { DEFAULT_ALIASES } from '../src/facets/schema.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = argOf('--dir');
if (!dir) {
  console.error('usage: node bin/memory-replay-hints.mjs --dir .durable-memory');
  process.exit(2);
}
const records = readEventLog(path.join(dir, 'events.jsonl'));
const aliases = Object.keys(DEFAULT_ALIASES).sort((a, b) => b.length - a.length);
const hints = [];
for (let index = 0; index < records.length; index += 1) {
  const current = records[index];
  const visible = records.slice(0, index);
  const entries = visible.map((record) => ({
    turn: record.turn,
    seqStart: record.seqStart,
    seqEnd: record.seqEnd,
    facets: record.facets,
    unknown: false,
  }));
  const mentioned = aliases.filter((alias) => current.text.includes(alias));
  for (const alias of mentioned) {
    const hint = buildLoadHint(entries, {
      query: alias,
      currentTurn: current.turn,
      recentTurns: 20,
      minScore: 0.2,
    });
    if (hint === null) continue;
    const turns = new Set();
    let chars = 0;
    for (const range of hint.ranges) {
      for (const record of visible) {
        if (record.seqStart >= range.seqStart && record.seqEnd <= range.seqEnd) {
          turns.add(record.turn);
          chars += record.text.length;
        }
      }
    }
    hints.push({
      turn: current.turn,
      alias,
      text: hint.text,
      topScore: hint.top.score,
      rangeCount: hint.ranges.length,
      rangeTurns: turns.size,
      chars,
      ranges: hint.ranges.map((range) => ({
        seqStart: range.seqStart,
        seqEnd: range.seqEnd,
        turns: range.turns,
        lastTurn: range.lastTurn,
      })),
      snippet: current.text.slice(0, 100).replace(/\s+/g, ' '),
    });
  }
}
const summary = {
  records: records.length,
  hints: hints.length,
  byAlias: Object.fromEntries([...new Set(hints.map((hint) => hint.alias))].map((alias) => [alias, hints.filter((hint) => hint.alias === alias).length])),
  futureLeaks: hints.filter((hint) => hint.ranges.some((range) => range.lastTurn >= hint.turn)).length,
  large: hints.filter((hint) => hint.rangeTurns > 50 || hint.chars > 10000).length,
  maxTurns: Math.max(0, ...hints.map((hint) => hint.rangeTurns)),
  maxChars: Math.max(0, ...hints.map((hint) => hint.chars)),
};
const output = { dir, summary, hints };
fs.writeFileSync(path.join(dir, 'REPLAY-HINTS.json'), JSON.stringify(output, null, 2));
console.log(JSON.stringify(summary, null, 2));
