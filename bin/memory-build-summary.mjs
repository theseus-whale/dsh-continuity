#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { buildSummaryTree, verifySummaryTree } from '../src/memory/summary-tree.mjs';
import { readEventLog } from '../src/memory/event-log.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const eventsFile = argOf('--events');
const outDir = argOf('--out') ?? '.durable-memory';
if (!eventsFile) {
  console.error('usage: node bin/memory-build-summary.mjs --events events.jsonl --out .durable-memory');
  process.exit(2);
}
const records = readEventLog(eventsFile);
const tree = buildSummaryTree(records, {
  segmentSize: Number(argOf('--segment')) || 8,
  chapterSize: Number(argOf('--chapter')) || 8,
});
fs.mkdirSync(outDir, { recursive: true });
const treeFile = path.join(outDir, 'summary-tree.json');
fs.writeFileSync(treeFile, `${JSON.stringify(tree, null, 2)}\n`, 'utf8');
const manifestFile = path.join(outDir, 'manifest.json');
if (fs.existsSync(manifestFile)) {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.layers.summary = {
    file: 'summary-tree.json',
    version: tree.version,
    nodeCount: tree.nodeCount,
    treeRootHash: tree.treeRootHash,
  };
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}
const verification = verifySummaryTree(tree);
console.log(JSON.stringify({
  out: treeFile,
  ...verification,
  levels: tree.levels,
  treeRootHash: tree.treeRootHash,
}, null, 2));
