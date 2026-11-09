import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { snapshotPlugin, verifyPlugin } from '../bin/plugin-integrity.mjs';

function tempPlugin() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-integrity-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"x"}');
  fs.writeFileSync(path.join(root, 'src', 'index.mjs'), 'export const x = 1;');
  return root;
}

test('snapshot verifies unchanged plugin', () => {
  const root = tempPlugin();
  const manifest = snapshotPlugin(root);
  assert.equal(verifyPlugin(root, manifest).ok, true);
});

test('snapshot detects changed and missing files', () => {
  const root = tempPlugin();
  const manifest = snapshotPlugin(root);
  fs.writeFileSync(path.join(root, 'src', 'index.mjs'), 'export const x = 2;');
  fs.rmSync(path.join(root, 'package.json'));
  const result = verifyPlugin(root, manifest);
  assert.equal(result.ok, false);
  assert.deepEqual(result.changed, ['src/index.mjs']);
  assert.deepEqual(result.missing, ['package.json']);
});
