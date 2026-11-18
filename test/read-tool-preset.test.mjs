import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { apply } from '../src/turn-ping/read-tool-plugin.mjs';

const repo = path.resolve('.');

test('preset-continuity and preset-continuity-ptc both register read-seq-range-tool', () => {
  const yml = fs.readFileSync(path.join(repo, 'cordis.patch.yml'), 'utf8');
  assert.equal((yml.match(/- id: read-seq-range-tool/g) ?? []).length, 2);
  assert.equal((yml.match(/name: ['"]?@theseus-whale\/dsh-continuity\/read-seq-range-tool/g) ?? []).length, 2);
});

test('package export exposes the preset plugin', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  assert.equal(pkg.exports['./read-seq-range-tool'], './src/turn-ping/read-tool-plugin.mjs');
  assert.equal(pkg.exports['./session-log-tool'], './src/session-log-tool.mjs');
});

test('preset apply registers read_seq_range and execute resolves from agent ctx', async () => {
  let tool = null;
  const ctx = {
    get: () => null,
    effect: (fn) => fn(),
    tools: { register: (value) => { tool = value; return () => {}; } },
  };
  apply(ctx);
  assert.equal(tool.name, 'read_seq_range');
  const sessionQuery = { async readSession() { return { events: [
    { seq: 1981, type: 'user/message', data: { source: { kind: 'user' }, content: 'raw question' } },
    { seq: 2000, type: 'assistant/message', data: { content: 'raw answer' } },
  ] }; } };
  const result = JSON.parse(await tool.execute({ fromSeq: 1981, toSeq: 2000 }, {
    agent: { session: { id: 's1' }, ctx: { get: (key) => key === 'sessionQuery' ? sessionQuery : undefined } },
  }));
  assert.equal(result.seqs[0], 1981);
  assert.ok(result.text.includes('raw answer'));
});
