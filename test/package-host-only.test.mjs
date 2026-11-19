import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('production package exposes no Node CLI or independent provider credentials', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  assert.equal(Object.hasOwn(pkg, 'bin'), false);
  assert.equal(Object.keys(pkg.scripts).some(key => /fullseed|migration/.test(key)), false);
  assert.equal(pkg.files.some(file => /^bin\//.test(file)), false);
  for (const removed of [
    'bin/fullseed-run.mjs', 'bin/fullseed-repair.mjs', 'bin/continuity-migrate.mjs',
    'src/fullseed/provider.mjs', 'src/fullseed/repair-provider.mjs', 'src/fullseed/repair.mjs',
  ]) assert.equal(fs.existsSync(path.resolve(removed)), false, `${removed} still exists`);
  for (const file of ['src/index.mjs', 'src/engine.mjs', 'src/fullseed/host-rebuild.mjs', 'src/fullseed/llm-adapter.mjs']) {
    const source = fs.readFileSync(path.resolve(file), 'utf8');
    assert.doesNotMatch(source, /createDeepseekStream|DSH_CONTINUITY_CREDENTIALS|DEEPSEEK_API_KEY|provider-module/);
  }
  const lock = JSON.parse(fs.readFileSync(path.resolve('package-lock.json'), 'utf8'));
  assert.equal(Object.hasOwn(lock.packages[''], 'bin'), false);
});
