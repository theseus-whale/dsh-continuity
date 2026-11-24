#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadActiveIndex } from '../src/fullseed/cache.mjs';
import {
  bestWithinWindow,
  buildChunkTimeline,
  resolveAnchor,
  scoreDirectionalCandidates,
} from '../src/fullseed/continuation-shadow.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const root = argOf('--root');
const anchorsPath = argOf('--anchors');
const output = argOf('--output');
if (!root || !anchorsPath) {
  console.error('usage: node bin/memory-continuation-selection-window-queue.mjs --root <fullseed> --anchors <anchors.jsonl> [--directions next,prev] [--output queue.jsonl]');
  process.exit(2);
}
const directions = String(argOf('--directions') ?? 'next,prev').split(',').filter(Boolean);
if (directions.some((direction) => direction !== 'next' && direction !== 'prev')) throw new Error('directions must be next,prev');

const active = loadActiveIndex(path.resolve(root), { fresh: true });
if (!active) throw new Error('active.json not found');
const timeline = buildChunkTimeline(active.merged.summaries, active.merged.vectors);
const source = fs.readFileSync(path.resolve(anchorsPath), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const unique = new Map();
for (const row of source) {
  const match = /^(\d+)-(\d+)$/.exec(String(row.from ?? row.anchor ?? ''));
  if (!match) throw new Error('each anchor row needs from=start-end');
  const key = row.fromChunkId ?? `${match[1]}-${match[2]}#${row.fromChunkIndex ?? ''}`;
  if (!unique.has(key)) unique.set(key, {
    chunkId: row.fromChunkId,
    seqStart: Number(match[1]),
    seqEnd: Number(match[2]),
    chunkIndex: row.fromChunkIndex,
  });
}

const entries = [];
let queueNumber = 0;
for (const selector of unique.values()) {
  const anchor = resolveAnchor(timeline, selector);
  for (const direction of directions) {
    const scored = scoreDirectionalCandidates(timeline, anchor, { direction, limit: 20 });
    for (const window of [5, 10, 20]) {
      const selected = bestWithinWindow(scored, window);
      queueNumber += 1;
      entries.push({
        queueId: `continuation-window-${String(queueNumber).padStart(3, '0')}`,
        criterionVersion: 'continuation-review-v1',
        ruleId: `highest-cosine-window-${window}`,
        rule: 'highest-cosine-within-ordinal-window',
        selectionSource: 'nextRelated-window-shadow',
        direction,
        window,
        anchor: `${anchor.seqStart}-${anchor.seqEnd}`,
        anchorChunkId: anchor.chunkId,
        anchorChunkIndex: anchor.chunkIndex,
        anchorSummary: anchor.summaryText,
        systemChoice: selected ? `${selected.seqStart}-${selected.seqEnd}` : null,
        candidateChunkId: selected?.chunkId ?? null,
        candidateChunkIndex: selected?.chunkIndex ?? null,
        candidateSummary: selected?.summaryText ?? null,
        selectionCosine: selected?.cosine ?? null,
        selectionOrdinalGap: selected?.ordinalGap ?? null,
        selectionSemanticRank: selected?.semanticRank ?? null,
        anchorStatus: '',
        judgment: '',
        why: '',
        evidence: '',
        confidence: '',
      });
    }
  }
}
const bytes = `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
if (output) fs.writeFileSync(path.resolve(output), bytes);
else process.stdout.write(bytes);
console.error(JSON.stringify({ entries: entries.length, emptySelections: entries.filter((entry) => !entry.systemChoice).length, checkpoint: active.active.checkpoint ?? null }));
