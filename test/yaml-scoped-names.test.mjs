import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('every scoped package name in cordis.patch.yml is single-quoted YAML', () => {
  const lines = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8').split(/\r?\n/);
  const names = lines.filter((line) => /^\s*name:\s*['"]?@theseus-whale\//.test(line));
  assert.equal(names.length, 10);
  for (const line of names) assert.match(line, /^\s*name:\s*'@theseus-whale\/dsh-continuity\/[^']+'\s*$/);
  assert.equal(lines.some((line) => /^\s*name:\s*@/.test(line)), false);
});
