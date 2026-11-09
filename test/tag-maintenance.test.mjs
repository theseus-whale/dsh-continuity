import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMaintenance } from '../src/tag-maintenance.mjs';
import { readTags } from '../src/tags-store.mjs';
import { canonicalTagRef, resolveTag } from '../src/tags.mjs';

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-maint-'));
  fs.writeFileSync(path.join(home, 'tags.json'), JSON.stringify({
    version: 1,
    tags: {
      T0: { label: '未分类' },
      't-big': { label: '中间闸与 thinkBack', alias: '中间闸', keywords: ['闸', '闸门'] },
      't-small': { label: '闸门', alias: '闸门', keywords: ['闸门'] },
      't-ghost': { label: '幽灵', alias: '幽灵' },
    },
    runs: [[1, 30, 't-big'], [10, 20, 't-small']],
    overrides: {},
    memberships: {},
  }, null, 2));
  fs.writeFileSync(path.join(home, 'turn-tags.jsonl'), [
    { turn: 1, tag: 't-big' },
    { turn: 2, tag: 't-big' },
    { turn: 3, tag: 't-big' },
    { turn: 4, tag: 't-big' },
    { turn: 5, tag: 't-big' },
    { turn: 6, tag: 't-big' },
    { turn: 7, tag: 't-big' },
    { turn: 8, tag: 't-big' },
    { turn: 9, tag: 't-big' },
    { turn: 10, tag: 't-big' },
    { turn: 11, tag: 't-small' },
    { turn: 12, tag: 't-small' },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');
  return home;
}

test('maintenance archives ghosts, normalizes aliases, merges and keeps seq', async () => {
  const home = fixture();
  try {
    const result = await runMaintenance({ home, mode: 'manual' });
    assert.equal(result.ghosts, 1);
    assert.equal(result.merged, 1);
    assert.equal(result.healthy, true);

    const read = await readTags(home);
    assert.equal(read.state.tags['t-ghost'].lifecycle, 'archived');
    assert.equal(read.state.tags['t-small'].lifecycle, 'merged');
    assert.equal(read.state.tags['t-small'].mergedInto, 't-big');
    assert.match(String(read.state.tags['t-big'].alias), /^T\d+$/);
    assert.equal(resolveTag(read.state, 15), 't-big');
    assert.equal(canonicalTagRef(read.state, 't-small'), 't-big');
    assert.equal(canonicalTagRef(read.state, '闸门'), 't-big');
    assert.equal(canonicalTagRef(read.state, '幽灵'), null);

    const md = fs.readFileSync(path.join(home, 'tags.md'), 'utf8');
    assert.match(md, /\| T\d+ \| 中间闸与 thinkBack/);
    assert.doesNotMatch(md, /幽灵/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('maintenance is idempotent', async () => {
  const home = fixture();
  try {
    await runMaintenance({ home, mode: 'manual' });
    const second = await runMaintenance({ home, mode: 'manual' });
    assert.equal(second.changed, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('an unused provisional tag expires after 20 turns and maps to T0', async () => {
  const home = fixture();
  try {
    const state = JSON.parse(fs.readFileSync(path.join(home, 'tags.json'), 'utf8'));
    state.tags['t-prov'] = { label: '一次性', alias: '一次性', keywords: ['一次性'], lifecycle: 'provisional', useCount: 1 };
    state.runs.push([31, 31, 't-prov']);
    fs.writeFileSync(path.join(home, 'tags.json'), JSON.stringify(state, null, 2));
    const rows = [];
    for (let turn = 1; turn <= 30; turn += 1) rows.push({ turn, tag: 't-big' });
    rows.push({ turn: 1, tag: 't-prov' });
    fs.writeFileSync(path.join(home, 'turn-tags.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

    const result = await runMaintenance({ home, mode: 'manual' });
    assert.equal(result.expired, 1);
    const read = await readTags(home);
    assert.equal(read.state.tags['t-prov'].lifecycle, 'archived');
    assert.equal(resolveTag(read.state, 31), 'T0');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
