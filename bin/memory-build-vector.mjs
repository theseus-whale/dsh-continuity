#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { readEventLog } from '../src/memory/event-log.mjs';
import { VectorIndex, loadEmbeddings } from '../src/memory/vector-index.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const eventsFile = argOf('--events');
const embeddingsFile = argOf('--embeddings');
const outDir = argOf('--out') ?? '.durable-memory';
if (!eventsFile || !embeddingsFile) {
  console.error('usage: node bin/memory-build-vector.mjs --events events.jsonl --embeddings embeddings.json --out .durable-memory');
  process.exit(2);
}
const records = readEventLog(eventsFile);
const vectors = loadEmbeddings(embeddingsFile);
const index = new VectorIndex().build(records, vectors);
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, 'vectors.json');
fs.writeFileSync(file, `${JSON.stringify(index.toJSON())}\n`, 'utf8');
const manifestFile = path.join(outDir, 'manifest.json');
if (fs.existsSync(manifestFile)) {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.layers.vector = { file: 'vectors.json', docs: index.docs.length };
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}
console.log(JSON.stringify({ out: file, docs: index.docs.length }, null, 2));
