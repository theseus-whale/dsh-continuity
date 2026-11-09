import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveTurnTag } from '../src/turn-tag.mjs';

test('多数派可投影', () => {
  const r = deriveTurnTag({ messages: [{ tag: 'T4' }, { tag: 'T4' }, { tag: 'T8' }] });
  assert.equal(r.tag, 'T4');
  assert.equal(r.reason, 'majority');
});

test('T0 不参与投票', () => {
  const r = deriveTurnTag({ messages: [{ tag: 'T0' }, { tag: 'T0' }, { tag: 'T4' }] });
  assert.equal(r.tag, 'T4');
});

test('全是 T0 → 判不出', () => {
  const r = deriveTurnTag({ messages: [{ tag: 'T0' }, { tag: 'T0' }] });
  assert.equal(r.tag, null);
  assert.equal(r.reason, 'no-tag');
});

test('打平 → 判不出（交给实例）', () => {
  const r = deriveTurnTag({ messages: [{ tag: 'T4' }, { tag: 'T8' }] });
  assert.equal(r.tag, null);
  assert.equal(r.reason, 'tie');
});

test('弱多数（<60%）→ 判不出', () => {
  const r = deriveTurnTag({ messages: [{ tag: 'T4' }, { tag: 'T8' }, { tag: 'T18' }] });
  assert.equal(r.tag, null);
  assert.equal(r.reason, 'tie');
});

test('两票对一票（66%）→ 可投影', () => {
  const r = deriveTurnTag({ messages: [{ tag: 'T4' }, { tag: 'T4' }, { tag: 'T8' }, { tag: 'T0' }] });
  assert.equal(r.tag, 'T4');
  assert.equal(r.share, 0.67); // T0 不计入分母：2/3
});
