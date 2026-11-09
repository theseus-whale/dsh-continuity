#!/usr/bin/env node
/**
 * Move the legacy global continuity index into sessions/<sessionId>/.
 * Dry-run by default; --apply writes the new tree and moves the old files
 * to *.migrated-<timestamp> backups (never deletes them).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadIndexJsonl, saveIndexJsonl } from '../src/memory/bc-index.mjs';
import { defaultConceptsPath } from '../src/memory/concepts-file.mjs';

const arg = (name, fallback = null) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] ?? fallback : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);
const home = arg('home', process.env.USERPROFILE ?? process.env.HOME ?? os.homedir());
const sessionId = arg('session-id');
if (!sessionId) {
  console.error('missing --session-id');
  process.exit(2);
}
const dir = path.join(home, '.dsh', 'continuity');
const globalIndex = path.join(dir, 'bc-index.jsonl');
if (!fs.existsSync(globalIndex)) {
  console.error(`no global index: ${globalIndex}`);
  process.exit(2);
}
const targetDir = path.join(dir, 'sessions', String(sessionId));
const targetIndex = path.join(targetDir, 'bc-index.jsonl');
if (fs.existsSync(targetIndex)) {
  console.error(`target already exists: ${targetIndex}`);
  process.exit(3);
}
const records = loadIndexJsonl(globalIndex);
const stamped = records.map((record) => ({ ...record, sessionId: String(sessionId) }));
const report = { sessionId, source: globalIndex, target: targetIndex, records: stamped.length, apply: has('apply') };
console.log(JSON.stringify(report, null, 2));
if (!has('apply')) {
  console.log('dry-run only; add --apply to migrate');
  process.exit(0);
}
fs.mkdirSync(targetDir, { recursive: true });
saveIndexJsonl(targetIndex, stamped);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
for (const name of ['audit-state.json', 'expand-hint.jsonl', 'expand-hint.pending.json', 'bc-index-state.json', 'bc-vectors.json']) {
  const from = path.join(dir, name);
  if (!fs.existsSync(from)) continue;
  if (name.endsWith('.json') || name.endsWith('.jsonl')) {
    fs.writeFileSync(path.join(targetDir, name), fs.readFileSync(from, 'utf8').replace(/^\uFEFF/, ''), 'utf8');
  } else {
    fs.copyFileSync(from, path.join(targetDir, name));
  }
  fs.renameSync(from, path.join(dir, `${name}.migrated-${stamp}`));
}
fs.renameSync(globalIndex, path.join(dir, `bc-index.jsonl.migrated-${stamp}`));
console.log(`migrated ${stamped.length} records to ${targetDir}`);
console.log(`legacy files suffixed .migrated-${stamp}`);
