import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  consumeTagReject,
  recordTagReject,
  renderTagRejectHeader,
} from '../src/tag-reject.mjs';

const now = Date.UTC(2026, 9, 30, 3, 41, 0);
const shownAt = new Date(now).toISOString();

test('a tag rejection is shown once, marked shown, then deleted on the next pre-step', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'continuity-tag-reject-'));
  const file = join(dir, 'tag-reject.json');
  try {
    const recorded = recordTagReject({
      file,
      turn: 1190,
      token: 'T99',
      kind: 'alias-missing',
      reason: 'T99 标签不存在',
      now,
    });
    assert.equal(recorded.shown, false);

    const first = consumeTagReject({ file, now });
    assert.equal(first.action, 'shown');
    assert.match(first.text, /^\n\[打标·退回\] 第 1190 轮/);
    assert.match(first.text, /你写的是「T99」/);
    assert.match(first.text, /T99 标签不存在/);
    assert.match(first.text, /turnmap\.mjs set --turn 1190 --tag <Tx>/);
    const marked = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(marked.shown, true);
    assert.equal(marked.shownAt, shownAt);

    const second = consumeTagReject({ file, now });
    assert.equal(second.action, 'deleted');
    assert.equal(second.text, '');
    await assert.rejects(() => readFile(file, 'utf8'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a second rejection for the same turn does not reset shown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'continuity-tag-reject-'));
  const file = join(dir, 'tag-reject.json');
  try {
    recordTagReject({ file, turn: 7, token: 'T99', kind: 'alias-missing', reason: 'no', now });
    assert.equal(consumeTagReject({ file, now }).action, 'shown');
    recordTagReject({ file, turn: 7, token: 'T98', kind: 'alias-missing', reason: 'again', now });
    const marked = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(marked.shown, true);
    assert.equal(marked.token, 'T98');
    const next = consumeTagReject({ file, now });
    assert.equal(next.action, 'deleted');
    assert.equal(next.text, '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a rejection for a new turn is shown again with the existing format', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'continuity-tag-reject-'));
  const file = join(dir, 'tag-reject.json');
  try {
    recordTagReject({ file, turn: 1, token: 'A', kind: 'alias-missing', reason: 'first', now });
    consumeTagReject({ file, now });
    consumeTagReject({ file, now });
    recordTagReject({ file, turn: 2, token: 'B', kind: 'label', reason: 'second', now });
    const shown = consumeTagReject({ file, now });
    assert.equal(shown.action, 'shown');
    assert.match(shown.text, /第 2 轮/);
    assert.match(shown.text, /B/);
    assert.match(shown.text, /second/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a rejection whose turn is already tagged is deleted without rendering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'continuity-tag-reject-'));
  const file = join(dir, 'tag-reject.json');
  try {
    recordTagReject({ file, turn: 1193, token: 'T99', kind: 'alias-missing', reason: 'T99 标签不存在', now });
    const consumed = consumeTagReject({ file, isResolved: (turn) => turn === 1193, now });
    assert.equal(consumed.action, 'deleted');
    assert.equal(consumed.reason, 'resolved');
    assert.equal(consumed.text, '');
    await assert.rejects(() => readFile(file, 'utf8'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('renderTagRejectHeader preserves the existing text shape', () => {
  const text = renderTagRejectHeader({ turn: 1190, token: 'T99', kind: 'alias-missing', reason: 'T99 标签不存在' });
  assert.equal(text, '\n[打标·退回] 第 1190 轮没有记下标签：你写的是「T99」——T99 标签不存在。'
    + '\n  修法：node ~/.dsh/continuity/turnmap.mjs set --turn 1190 --tag <Tx>'
    + '（写别名，或写一个表里没有的新词；引号里的词按字面处理）');
});
