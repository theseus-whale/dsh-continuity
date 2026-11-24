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
  scorePair,
  thresholdSweep,
} from '../src/fullseed/continuation-shadow.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = (name) => args.includes(name);
const numberArg = (name) => {
  const value = argOf(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be numeric`);
  return parsed;
};
const usage = () => {
  console.error(`usage:
  node bin/memory-continuation-shadow.mjs --root <fullseed> (--chunk-id <id> | --seq-start <n> [--seq-end <n>] [--chunk-index <n>]) [--direction next|prev] [--time-limit 12] [--semantic-limit 8] [--threshold <cosine>] [--json]
  node bin/memory-continuation-shadow.mjs --root <fullseed> --labels <pairs.jsonl> [--json]`);
};

try {
  const root = argOf('--root');
  if (!root) { usage(); process.exitCode = 2; } else {
    const active = loadActiveIndex(path.resolve(root), { fresh: true });
    if (!active) throw new Error('active.json not found');
    const timeline = buildChunkTimeline(active.merged.summaries, active.merged.vectors);
    const labelsPath = argOf('--labels');
    let report;
    if (labelsPath) {
      const labels = fs.readFileSync(path.resolve(labelsPath), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
      const rows = labels.map((label) => {
        const endpoint = (rangeKey, chunkIdKey, chunkIndexKey) => {
          if (label[chunkIdKey]) return { chunkId: label[chunkIdKey] };
          const match = /^(\d+)-(\d+)$/.exec(String(label[rangeKey] ?? ''));
          if (!match) throw new Error(`label needs ${chunkIdKey} or ${rangeKey}=start-end`);
          return { seqStart: Number(match[1]), seqEnd: Number(match[2]), chunkIndex: label[chunkIndexKey] };
        };
        const anchor = resolveAnchor(timeline, endpoint('from', 'anchorChunkId', 'fromChunkIndex'));
        const candidate = resolveAnchor(timeline, endpoint('to', 'candidateChunkId', 'toChunkIndex'));
        const direction = label.direction ?? (label.label === 'same-thread-prev' || candidate.seqStart < anchor.seqStart || candidate.seqEnd < anchor.seqEnd ? 'prev' : 'next');
        const kind = label.kind ?? label.label;
        const binaryLabel = label.label === 0 || label.label === 1 ? label.label
          : ['same-thread-next', 'same-thread-prev', 'split-chunk'].includes(label.label) ? 1
            : ['adjacent-different-topic', 'same-domain-different-thread'].includes(label.label) ? 0
              : (() => { throw new Error(`unknown continuation label: ${label.label}`); })();
        const scored = scoreDirectionalCandidates(timeline, anchor, { direction });
        if (!scored.some((row) => row.chunkId === candidate.chunkId)) throw new Error(`candidate ${candidate.chunkId} is not ${direction} of anchor ${anchor.chunkId}`);
        return {
          ...label,
          kind,
          label: binaryLabel,
          split: label.split ?? 'calibration',
          direction,
          anchor: publicChunk(anchor),
          candidate: publicChunk(candidate),
          ...scorePair(anchor, candidate, direction),
        };
      });
      report = {
        mode: 'pair-evaluation',
        checkpoint: active.active.checkpoint,
        chunks: timeline.length,
        rows,
        sweep: thresholdSweep(rows),
        splits: Object.fromEntries([...new Set(rows.map((row) => row.split ?? 'unsplit'))].sort().map((split) => [split, thresholdSweep(rows.filter((row) => (row.split ?? 'unsplit') === split))])),
        warning: 'Observed scores only. Choose on calibration labels and verify on disjoint held-out labels; few examples do not establish a production threshold.',
      };
    } else {
      const anchor = resolveAnchor(timeline, {
        chunkId: argOf('--chunk-id'),
        seqStart: numberArg('--seq-start'),
        seqEnd: numberArg('--seq-end'),
        chunkIndex: numberArg('--chunk-index'),
      });
      const direction = argOf('--direction') ?? 'next';
      const timeLimit = numberArg('--time-limit') ?? 12;
      const semanticLimit = numberArg('--semantic-limit') ?? 8;
      const threshold = numberArg('--threshold');
      const scored = scoreDirectionalCandidates(timeline, anchor, { direction });
      const chosen = new Set([
        ...scored.slice(0, timeLimit).map((row) => row.chunkId),
        ...[...scored].sort((left, right) => left.semanticRank - right.semanticRank).slice(0, semanticLimit).map((row) => row.chunkId),
      ]);
      const candidates = scored.filter((row) => chosen.has(row.chunkId)).map((row) => ({
        ...row,
        views: [
          ...(row.ordinalGap <= timeLimit ? ['time'] : []),
          ...(row.semanticRank <= semanticLimit ? ['semantic'] : []),
        ],
      }));
      const selected = earliestAboveThreshold(scored, threshold);
      report = {
        mode: 'directed-continuation-shadow',
        checkpoint: active.active.checkpoint,
        chunks: timeline.length,
        anchor: publicChunk(anchor),
        direction,
        candidateCount: scored.length,
        threshold: threshold ?? null,
        selected: selected ? publicChunk(selected) : null,
        selectionNote: threshold === undefined ? 'measurement only; no threshold supplied' : 'earliest candidate at or above the experimental cosine threshold',
        candidates,
      };
    }
    if (has('--json')) {
      console.log(JSON.stringify(report, null, 2));
    } else if (report.mode === 'pair-evaluation') {
      console.log(`续接 shadow｜checkpoint ${report.checkpoint}｜chunks ${report.chunks}｜标注 ${report.rows.length}`);
      for (const row of report.rows) {
        console.log(`${row.label ? '正例' : '负例'} ${row.split ?? 'unsplit'} ${row.kind ?? 'untyped'}｜${row.anchor.seqStart}-${row.anchor.seqEnd}#${row.anchor.chunkIndex} → ${row.candidate.seqStart}-${row.candidate.seqEnd}#${row.candidate.chunkIndex}｜cos ${row.cosine.toFixed(6)}｜entity ${row.entities.dice.toFixed(3)}｜lex ${row.lexical.dice.toFixed(3)}`);
      }
      console.log('阈值扫描（仅当前标注描述，不是生产建议）：');
      for (const row of report.sweep) {
        console.log(`cos >= ${row.threshold.toFixed(6)}｜P ${row.precision?.toFixed(3) ?? '-'}｜R ${row.recall?.toFixed(3) ?? '-'}｜FPR ${row.falsePositiveRate?.toFixed(3) ?? '-'}｜TP/FP/TN/FN ${row.tp}/${row.fp}/${row.tn}/${row.fn}`);
      }
      console.log(report.warning);
    } else {
      console.log(`续接 shadow｜checkpoint ${report.checkpoint}｜chunks ${report.chunks}｜${report.direction}`);
      console.log(`锚点 ${report.anchor.seqStart}-${report.anchor.seqEnd}#${report.anchor.chunkIndex}｜${report.anchor.chunkId}`);
      console.log(`方向候选 ${report.candidateCount}｜阈值 ${report.threshold ?? '未设（只测量）'}｜演示选择 ${report.selected ? `${report.selected.seqStart}-${report.selected.seqEnd}#${report.selected.chunkIndex}` : '无'}`);
      for (const row of report.candidates) {
        console.log(`${row.seqStart}-${row.seqEnd}#${row.chunkIndex}｜cos ${row.cosine.toFixed(6)}｜entity ${row.entities.dice.toFixed(3)}｜lex ${row.lexical.dice.toFixed(3)}｜time ${row.ordinalGap}｜semantic ${row.semanticRank}｜${row.views.join('+')}｜${row.summaryText}`);
      }
    }
  }
} catch (error) {
  console.error(`continuation shadow: ${error.message}`);
  process.exitCode = 1;
}
