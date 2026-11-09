#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildEventLog, writeEventLog, verifyEventLog, readEventLog } from '../src/memory/event-log.mjs';
import { BM25Index } from '../src/memory/bm25.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const input = argOf('--input');
const outDir = argOf('--out') ?? '.durable-memory';
if (!input) {
  console.error('usage: node bin/memory-build.mjs --input rows.jsonl --out .durable-memory');
  process.exit(2);
}
const source = fs.readFileSync(input);
const sourceSha = createHash('sha256').update(source).digest('hex');
const rows = source.toString('utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const records = buildEventLog(rows);
fs.mkdirSync(outDir, { recursive: true });
const eventFile = path.join(outDir, 'events.jsonl');
const eventResult = writeEventLog(eventFile, records);
const bm25 = new BM25Index().build(records);
fs.writeFileSync(path.join(outDir, 'bm25.json'), `${JSON.stringify(bm25.toJSON())}\n`, 'utf8');
const manifest = {
  schema: 1,
  sourceFile: path.basename(input),
  sourceSha,
  eventCount: records.length,
  rootHash: eventResult.rootHash,
  layers: {
    event: { file: 'events.jsonl', count: records.length, rootHash: eventResult.rootHash },
    bm25: { file: 'bm25.json', docs: bm25.docs.length },
  },
};
fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
const verification = verifyEventLog(readEventLog(eventFile));
console.log(JSON.stringify({ outDir, sourceSha, eventFile, ...verification, bm25Docs: bm25.docs.length }, null, 2));
