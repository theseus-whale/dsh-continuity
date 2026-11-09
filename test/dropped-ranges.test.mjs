import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rebuildDroppedRanges } from '../src/state.mjs';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dropped-ranges-'));
}

test('dropped-ranges are split by session and never merge seq spaces', () => {
  const home = tempHome();
  const old = process.env.USERPROFILE;
  process.env.USERPROFILE = home;
  try {
    const root = path.join(home, '.dsh', 'continuity');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'passes.jsonl'), [
      JSON.stringify({ sessionId: 's1', start: 1, end: 5, at: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ sessionId: 's2', start: 1, end: 3, at: '2026-01-01T00:00:00Z' }),
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(root, 'folds.json'), JSON.stringify({
      sessions: {
        s1: { folds: [{ from: 4, to: 8, at: '2026-01-01T00:00:00Z' }] },
        s2: { folds: [{ from: 2, to: 4, at: '2026-01-01T00:00:00Z' }] },
      },
    }));
    rebuildDroppedRanges();
    const one = JSON.parse(fs.readFileSync(path.join(root, 'sessions', 's1', 'dropped-ranges.json'), 'utf8'));
    const two = JSON.parse(fs.readFileSync(path.join(root, 'sessions', 's2', 'dropped-ranges.json'), 'utf8'));
    assert.deepEqual(one.ranges, [[1, 8]]);
    assert.equal(one.totalSeqs, 8);
    assert.deepEqual(two.ranges, [[1, 4]]);
    assert.equal(two.totalSeqs, 4);
    assert.equal(fs.existsSync(path.join(root, 'dropped-ranges.json')), false);
  } finally {
    if (old === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = old;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
