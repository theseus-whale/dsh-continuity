import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('production index wires fullseed LLM provider, not legacy summaryProvider', () => {
  const index = fs.readFileSync(path.join(process.cwd(), 'src/index.mjs'), 'utf8');
  assert.match(index, /createFullseedLlmProvider/);
  assert.match(index, /provider: fullseedProvider/);
  assert.match(index, /createFullseedWorker/);
  assert.doesNotMatch(index, /createFullseedWorker\(\{[\s\S]*provider: summaryProvider/);
});

test('host payload shape is agent/turn-stopping with injected agent', () => {
  const worker = fs.readFileSync(path.join(process.cwd(), 'src/fullseed/worker.mjs'), 'utf8');
  assert.match(worker, /async \(\{ agent, turn \} = \{\}\)/);
  assert.match(worker, /sessionIdOf\(agent/);
});
