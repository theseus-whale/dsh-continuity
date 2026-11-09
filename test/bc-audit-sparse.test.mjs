import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAudit } from '../src/memory/bc-audit.mjs';
import { maybeRunAudit, readAuditState } from '../src/memory/bc-audit.mjs';

function vec(seed) {
  const values = new Float32Array(512);
  for (let i = 0; i < values.length; i += 1) values[i] = Math.sin(seed + i);
  return Buffer.from(values.buffer).toString('base64');
}

for (const count of [1, 5, 19]) {
  test(`audit terminates with ${count} sparse vector record(s)`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-sparse-'));
    try {
      const indexFile = path.join(dir, 'bc-index.jsonl');
      const conceptsFile = path.join(dir, 'concepts.md');
      const rows = [];
      for (let turn = 1; turn <= count; turn += 1) {
        rows.push(JSON.stringify({
          turn,
          seqStart: turn,
          seqEnd: turn,
          vec: vec(turn),
          chatter: 0.1,
          keywords: [],
          conceptScores: { 示例: 0.2 },
          generic: [],
        }));
      }
      fs.writeFileSync(indexFile, `${rows.join('\n')}\n`, 'utf8');
      fs.writeFileSync(conceptsFile, '# A\n示例 | 示例、词 | 1 | topic\n', 'utf8');
      const result = await runAudit({ indexFile, conceptsFile });
      assert.equal(result.candidates, 0);
      assert.equal(fs.existsSync(path.join(dir, 'audit-state.json')), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

function encoded(values) {
  return Buffer.from(new Float32Array(values).buffer).toString('base64');
}

test('audit rejects malformed, non-finite, zero, and mixed-dimension vectors', async () => {
  const cases = [
    '!!!not-base64!!!',
    encoded([0, Number.NaN, 1]),
    encoded([0, 0, 0]),
    encoded(new Array(256).fill(0.1)),
    encoded(new Array(512).fill(0.1)) + '!!!!',
  ];
  for (const [index, bad] of cases.entries()) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-bad-'));
    try {
      const indexFile = path.join(dir, 'bc-index.jsonl');
      const conceptsFile = path.join(dir, 'concepts.md');
      const good = vec(1);
      const records = index === 3
        ? [{ turn: 1, vec: good, conceptScores: { 示例: 0.1 }, chatter: 0.1 }, { turn: 2, vec: bad, conceptScores: { 示例: 0.1 }, chatter: 0.1 }]
        : [{ turn: 1, vec: bad, conceptScores: { 示例: 0.1 }, chatter: 0.1 }];
      fs.writeFileSync(indexFile, records.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
      fs.writeFileSync(conceptsFile, '# A\n示例 | 示例、词 | 1 | topic\n', 'utf8');
      await assert.rejects(() => runAudit({ indexFile, conceptsFile }));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('stale running flag is recovered; recent running flag is not', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-running-'));
  try {
    const indexFile = path.join(dir, 'bc-index.jsonl');
    const conceptsFile = path.join(dir, 'concepts.md');
    fs.writeFileSync(indexFile, JSON.stringify({ turn: 1, vec: vec(1), conceptScores: { 示例: 0.1 }, chatter: 0.1 }) + '\n', 'utf8');
    fs.writeFileSync(conceptsFile, '# A\n示例 | 示例、词 | 1 | topic\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'audit-state.json'), JSON.stringify({ lastAuditTurn: 0, running: true }), 'utf8');
    assert.equal(maybeRunAudit({ indexFile, conceptsFile, lastTurn: 200 }), true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'audit-state.json'), 'utf8'));
    assert.equal(state.running, false);
    assert.equal(state.runningAt, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('audit state JSON null is normalized and does not block scheduling', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-null-'));
  try {
    const indexFile = path.join(dir, 'bc-index.jsonl');
    fs.writeFileSync(path.join(dir, 'audit-state.json'), 'null\n', 'utf8');
    assert.deepEqual(readAuditState(indexFile), { lastAuditTurn: 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recent foreign audit lock blocks and is preserved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-lock-'));
  try {
    const indexFile = path.join(dir, 'bc-index.jsonl');
    const conceptsFile = path.join(dir, 'concepts.md');
    fs.writeFileSync(indexFile, JSON.stringify({ turn: 1, vec: vec(1), conceptScores: { 示例: 0.1 }, chatter: 0.1 }) + '\n', 'utf8');
    fs.writeFileSync(conceptsFile, '# A\n示例 | 示例、词 | 1 | topic\n', 'utf8');
    const lock = path.join(dir, 'audit.lock');
    fs.writeFileSync(lock, JSON.stringify({ token: 'other-owner', pid: 1, at: Date.now() }), 'utf8');
    assert.equal(maybeRunAudit({ indexFile, conceptsFile, lastTurn: 200 }), false);
    assert.equal(fs.existsSync(lock), true);
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'other-owner');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('expired audit lock is quarantined and replaced', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-lock-stale-'));
  try {
    const indexFile = path.join(dir, 'bc-index.jsonl');
    const conceptsFile = path.join(dir, 'concepts.md');
    fs.writeFileSync(indexFile, JSON.stringify({ turn: 1, vec: vec(1), conceptScores: { 示例: 0.1 }, chatter: 0.1 }) + '\n', 'utf8');
    fs.writeFileSync(conceptsFile, '# A\n示例 | 示例、词 | 1 | topic\n', 'utf8');
    const lock = path.join(dir, 'audit.lock');
    fs.writeFileSync(lock, JSON.stringify({ token: 'stale-owner', pid: 1, at: Date.now() }), 'utf8');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(lock, old, old);
    assert.equal(maybeRunAudit({ indexFile, conceptsFile, lastTurn: 200 }), true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.existsSync(lock), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
