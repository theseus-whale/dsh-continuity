#!/usr/bin/env node
/**
 * Local facet-head calibration on the copied history.
 * Labels are weak T-derived labels, not human gold.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readEventLog } from '../src/memory/event-log.mjs';
import { deserializeMlp, predictMlp } from '../src/facets/mlp-probe.mjs';
import { reliabilityBins, thresholdCurve, chooseThreshold } from '../src/memory/calibration.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = argOf('--dir');
const modelPath = argOf('--model');
const embeddingsPath = argOf('--embeddings');
if (!dir || !modelPath || !embeddingsPath) {
  console.error('usage: node bin/memory-calibration.mjs --dir .durable-memory --model MLP-MODEL.json --embeddings embeddings-1500.json');
  process.exit(2);
}
const records = readEventLog(path.join(dir, 'events.jsonl'));
const vectors = new Map(JSON.parse(fs.readFileSync(embeddingsPath, 'utf8')).map((row) => [row.turn, row.vector]));
const model = deserializeMlp(JSON.parse(fs.readFileSync(modelPath, 'utf8')));
const classes = new Set(model.slots.activity.classes);
const points = [];
let skipped = 0;
for (const record of records) {
  const vector = vectors.get(record.turn);
  if (vector === undefined) {
    skipped += 1;
    continue;
  }
  const actual = record.facets.activity;
  if (!classes.has(actual)) {
    skipped += 1;
    continue;
  }
  const prediction = predictMlp(model, vector);
  points.push({
    turn: record.turn,
    confidence: prediction.confidence.activity,
    correct: prediction.facets.activity === actual,
    predicted: prediction.facets.activity,
    actual,
  });
}
const summary = {
  model: path.basename(modelPath),
  total: records.length,
  evaluated: points.length,
  skipped,
  accuracy: points.filter((point) => point.correct).length / points.length,
  averageConfidence: points.reduce((sum, point) => sum + point.confidence, 0) / points.length,
  bins: reliabilityBins(points),
  curve: thresholdCurve(points),
  target90: chooseThreshold(points, { targetPrecision: 0.9 }),
  target80: chooseThreshold(points, { targetPrecision: 0.8 }),
};
fs.writeFileSync(path.join(dir, 'CALIBRATION.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({
  evaluated: summary.evaluated,
  skipped: summary.skipped,
  accuracy: +summary.accuracy.toFixed(3),
  averageConfidence: +summary.averageConfidence.toFixed(3),
  target90: summary.target90,
  target80: summary.target80,
}, null, 2));
