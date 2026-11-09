#!/usr/bin/env node
/**
 * Race true incremental learners from turn 1.
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { OnlineFacetKnn } from '../src/facets/online-knn.mjs';
import { OnlineCentroid, OnlineCentroidVariance, OnlineNaiveBayes } from '../src/facets/online-models.mjs';
import { detectRandom } from '../src/facets/random.mjs';
import { SLOTS } from '../src/facets/schema.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = argOf('--dir') ?? 'C:/Users/example/Documents/DeepSeek\'s Sandbox/coopanion-continuity/backups/continuity-tags-20261031/online400';
const rows = fs.readFileSync(path.join(dir, 'continuity-1500.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const embeddings = JSON.parse(fs.readFileSync(path.join(dir, 'embeddings-1500.json'), 'utf8'));
const vectorByTurn = new Map(embeddings.map((row) => [row.turn, row.vector]));
const checkpoints = [50, 100, 200, 400, 800, 1200, 1480];

function evaluate(name, learner, predictFn, updateFn) {
  const report = Object.fromEntries(SLOTS.map((slot) => [slot, { total: 0, covered: 0, correct: 0 }]));
  const checkpointsOut = [];
  let unknown = 0;
  let checkpointIndex = 0;
  const t0 = performance.now();
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const vector = vectorByTurn.get(row.turn);
    const predicted = predictFn(learner, row.text, vector);
    predicted.facets.random = detectRandom(row.text).value;
    if (predicted.unknown) unknown += 1;
    for (const slot of SLOTS) {
      if (row.facets[slot] === undefined) continue;
      report[slot].total += 1;
      if (predicted.facets[slot] === undefined) continue;
      report[slot].covered += 1;
      if (predicted.facets[slot] === row.facets[slot]) report[slot].correct += 1;
    }
    updateFn(learner, vector, row.text, row.facets);
    while (checkpointIndex < checkpoints.length && row.turn >= checkpoints[checkpointIndex]) {
      const checkpoint = checkpoints[checkpointIndex];
      checkpointIndex += 1;
      const rep = {};
      for (const slot of SLOTS) {
        const x = report[slot];
        rep[slot] = {
          total: x.total,
          covered: x.covered,
          correct: x.correct,
          coverage: x.total === 0 ? 0 : x.covered / x.total,
          accuracy: x.covered === 0 ? 0 : x.correct / x.covered,
        };
      }
      checkpointsOut.push({ turn: row.turn, checkpoint, indexed: rowIndex + 1, unknown, report: rep });
    }
  }
  const mem = process.memoryUsage();
  const elapsed = performance.now() - t0;
  return {
    name,
    rows: rows.length,
    timeMs: Math.round(elapsed),
    msPerTurn: +(elapsed / rows.length).toFixed(2),
    memory: { heapMB: +(mem.heapUsed / 1048576).toFixed(1), rssMB: +(mem.rss / 1048576).toFixed(1) },
    checkpoints: checkpointsOut,
  };
}

const results = [];
results.push(evaluate('centroid', new OnlineCentroid(),
  (m, text, vector) => m.predict(vector),
  (m, vector, text, facets) => m.update(vector, facets)));
results.push(evaluate('centroidVariance', new OnlineCentroidVariance(),
  (m, text, vector) => m.predict(vector),
  (m, vector, text, facets) => m.update(vector, facets)));
results.push(evaluate('naiveBayes', new OnlineNaiveBayes(),
  (m, text) => m.predict(text),
  (m, vector, text, facets) => m.update(text, facets)));
results.push(evaluate('knn', new OnlineFacetKnn({ k: 5, minSimilarity: 0.15, minVote: 0.5 }),
  (m, text, vector) => m.predict(vector),
  (m, vector, text, facets) => m.add(vector, facets)));

fs.writeFileSync(path.join(dir, 'ONLINE-RACE-1462.json'), JSON.stringify(results, null, 2));
const summary = results.map((r) => ({
  name: r.name,
  msPerTurn: r.msPerTurn,
  memory: r.memory,
  checkpoints: r.checkpoints.map((c) => ({
    checkpoint: c.checkpoint,
    activity: c.report.activity.accuracy,
    topic: c.report.topic.accuracy,
    coverage: [c.report.activity.coverage, c.report.topic.coverage],
  })),
}));
console.log(JSON.stringify(summary, null, 2));
