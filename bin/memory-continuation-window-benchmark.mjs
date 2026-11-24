#!/usr/bin/env node
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadActiveIndex } from '../src/fullseed/cache.mjs';
import {
  bestWithinWindow,
  buildChunkTimeline,
  scoreDirectionalCandidates,
} from '../src/fullseed/continuation-shadow.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const root = argOf('--root');
if (!root) {
  console.error('usage: node bin/memory-continuation-window-benchmark.mjs --root <fullseed> [--anchors 32] [--window-repeats 100] [--full-repeats 10]');
  process.exit(2);
}
const anchorCount = Number(argOf('--anchors') ?? 32);
const windowRepeats = Number(argOf('--window-repeats') ?? 100);
const fullRepeats = Number(argOf('--full-repeats') ?? 10);
if (![anchorCount, windowRepeats, fullRepeats].every((value) => Number.isInteger(value) && value > 0)) throw new Error('counts must be positive integers');

const loadStart = performance.now();
const active = loadActiveIndex(path.resolve(root), { fresh: true });
if (!active) throw new Error('active.json not found');
const loadMs = performance.now() - loadStart;
const timelineStart = performance.now();
const timeline = buildChunkTimeline(active.merged.summaries, active.merged.vectors);
const buildTimelineMs = performance.now() - timelineStart;
const eligible = timeline.map((chunk, index) => ({ chunk, index })).filter(({ index }) => index >= 20 && index < timeline.length - 20);
if (eligible.length === 0) throw new Error('no eligible anchors');
const anchors = Array.from({ length: Math.min(anchorCount, eligible.length) }, (_, index) => eligible[Math.floor((index + 0.5) * eligible.length / Math.min(anchorCount, eligible.length))].chunk);

function runWindow() {
  for (const anchor of anchors) {
    for (const direction of ['next', 'prev']) {
      const scored = scoreDirectionalCandidates(timeline, anchor, { direction, limit: 20 });
      for (const window of [5, 10, 20]) bestWithinWindow(scored, window);
    }
  }
}
function runFull() {
  for (const anchor of anchors) {
    for (const direction of ['next', 'prev']) scoreDirectionalCandidates(timeline, anchor, { direction });
  }
}
function measure(fn, repeats) {
  const samples = [];
  for (let index = 0; index < repeats; index += 1) {
    const start = performance.now();
    fn();
    samples.push((performance.now() - start) / anchors.length);
  }
  samples.sort((left, right) => left - right);
  const sum = samples.reduce((total, value) => total + value, 0);
  const percentile = (fraction) => samples[Math.min(samples.length - 1, Math.ceil(samples.length * fraction) - 1)];
  return {
    repeats,
    anchorCount: anchors.length,
    perAnchorMs: {
      mean: sum / samples.length,
      median: percentile(0.5),
      p95: percentile(0.95),
      min: samples[0],
      max: samples.at(-1),
    },
  };
}
for (let index = 0; index < 5; index += 1) runWindow();
for (let index = 0; index < 1; index += 1) runFull();
console.log(JSON.stringify({
  checkpoint: active.active.checkpoint ?? null,
  chunks: timeline.length,
  vectorDimension: timeline[0]?.vector.length ?? 0,
  loadMs,
  buildTimelineMs,
  windowBothDirectionsSixSelections: measure(runWindow, windowRepeats),
  fullBothDirections: measure(runFull, fullRepeats),
}, null, 2));
