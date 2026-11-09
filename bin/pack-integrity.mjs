#!/usr/bin/env node
/**
 * Pack integrity check: compare selected files inside a .tgz with the dev tree.
 *
 *   node bin/pack-integrity.mjs --tgz path/to/pkg.tgz --root . \
 *     --files src/memory/relabel-migrate.mjs,src/memory/bc-pre-step.mjs
 *
 * Exits 1 on any mismatch. This catches the "packaged an old public copy"
 * failure mode without trusting the version number.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const tgz = arg('tgz');
const root = arg('root', '.');
const files = String(arg('files', '')).split(',').map((file) => file.trim()).filter(Boolean);
if (!tgz || files.length === 0) {
  console.error('usage: node bin/pack-integrity.mjs --tgz <file.tgz> --root <dir> --files a,b');
  process.exit(2);
}

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
let failed = 0;
for (const file of files) {
  const local = `${root.replace(/[\\/]+$/, '')}/${file}`;
  const expected = sha(readFileSync(local));
  const result = spawnSync('tar', ['-xOf', tgz, `package/${file}`]);
  if (result.status !== 0) {
    console.error(`MISSING ${file}: ${result.stderr?.toString().trim() || 'tar failed'}`);
    failed += 1;
    continue;
  }
  const actual = sha(result.stdout);
  if (actual !== expected) {
    console.error(`MISMATCH ${file}: dev ${expected.slice(0, 12)} vs tgz ${actual.slice(0, 12)}`);
    failed += 1;
  } else {
    console.log(`OK ${file} ${actual.slice(0, 12)}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
