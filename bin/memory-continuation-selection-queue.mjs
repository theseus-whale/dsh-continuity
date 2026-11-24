#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadActiveIndex } from '../src/fullseed/cache.mjs';
import {
  buildChunkTimeline,
  earliestAboveThreshold,
  publicChunk,
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
const thresholds = String(argOf('--thresholds') ?? '').split(',').filter(Boolean).map(Number);
if (!root || !anchorsPath || thresholds.length === 0 || thresholds.some((value) => !Number.isFinite(value))) {
  console.error('usage: node bin/memory-continuation-selection-queue.mjs --root <fullseed> --anchors <labels-with-from.jsonl> --thresholds <t1,t2,...> [--directions next,prev]');
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
  const key = `${match[1]}-${match[2]}#${row.fromChunkIndex ?? ''}`;
  if (!unique.has(key)) unique.set(key, { seqStart: Number(match[1]), seqEnd: Number(match[2]), chunkIndex: row.fromChunkIndex });
}

let queueNumber = 0;
for (const selector of unique.values()) {
  const anchor = resolveAnchor(timeline, selector);
  for (const direction of directions) {
    const scored = scoreDirectionalCandidates(timeline, anchor, { direction });
    for (let index = 0; index < thresholds.length; index += 1) {
      const threshold = thresholds[index];
      const selected = earliestAboveThreshold(scored, threshold);
      queueNumber += 1;
      const entry = {
        queueId: `continuation-${String(queueNumber).padStart(3, '0')}`,
        criterionVersion: 'continuation-review-v1',
        ruleId: `calibration-cosine-${index + 1}`,
        rule: 'earliest-cosine-at-or-above-threshold',
        threshold,
        selectionSource: 'nextRelated-shadow',
        direction,
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
      };
      console.log(JSON.stringify(entry));
    }
  }
}
