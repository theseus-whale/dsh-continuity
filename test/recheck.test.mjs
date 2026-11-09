import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECHECK_FIRST_TAGS,
  bumpTagCount,
  emptyRecheckState,
  parseRecheckAnswer,
  recheckAutoText,
  recheckRetryText,
  resetTagCount,
} from '../src/recheck.mjs';

test('TAG count is silent before the first threshold', () => {
  let state = emptyRecheckState();
  for (let index = 1; index < RECHECK_FIRST_TAGS; index += 1) {
    const result = bumpTagCount(state, { threadId: 't-test' });
    assert.equal(result.due, false, 'tag ' + index);
    state = result.state;
  }
});

test('TAG count asks at the first threshold', () => {
  let state = emptyRecheckState();
  for (let index = 1; index <= RECHECK_FIRST_TAGS; index += 1) {
    const result = bumpTagCount(state, { threadId: 't-test' });
    state = result.state;
    if (index < RECHECK_FIRST_TAGS) assert.equal(result.due, false);
    else assert.equal(result.due, true);
  }
});

test('reset clears the T count and starts a fresh threshold', () => {
  let state = emptyRecheckState();
  for (let index = 1; index <= RECHECK_FIRST_TAGS; index += 1) state = bumpTagCount(state, { threadId: 't-test' }).state;
  state = resetTagCount(state, { threadId: 't-test' }).state;
  assert.equal(state.threads['t-test'].count, 0);
  for (let index = 1; index < RECHECK_FIRST_TAGS; index += 1) {
    const result = bumpTagCount(state, { threadId: 't-test' });
    assert.equal(result.due, false);
    state = result.state;
  }
});

test('counts are independent per T', () => {
  let state = emptyRecheckState();
  for (let index = 1; index <= RECHECK_FIRST_TAGS; index += 1) state = bumpTagCount(state, { threadId: 't-a' }).state;
  const b = bumpTagCount(state, { threadId: 't-b' });
  assert.equal(b.due, false);
  assert.equal(b.entry.count, 1);
});

test('state survives JSON round-trip', () => {
  let state = emptyRecheckState();
  for (let index = 1; index <= 3; index += 1) state = bumpTagCount(state, { threadId: 't-test' }).state;
  const restored = JSON.parse(JSON.stringify(state));
  const next = bumpTagCount(restored, { threadId: 't-test' });
  assert.equal(next.entry.count, 4);
});

test('recheck answer parser accepts both [回查] and [闸·回查]', () => {
  assert.equal(parseRecheckAnswer('[回查] y'), 'yes');
  assert.equal(parseRecheckAnswer('[回查] n'), 'no');
  assert.equal(parseRecheckAnswer('[闸·回查] y'), 'yes');
  assert.equal(parseRecheckAnswer('[闸·回查] n'), 'no');
  assert.equal(parseRecheckAnswer('y'), 'yes');
  assert.equal(parseRecheckAnswer('something\ny\nTAG: T14 — x'), 'yes');
  assert.equal(parseRecheckAnswer('something\nTAG: T14 — x'), null);
  assert.equal(parseRecheckAnswer('I say yes but not on its own line'), null);
});

test('recheck retry and auto-y texts are explicit and friendly', () => {
  assert.match(recheckRetryText('T14'), /连续 3 次/);
  assert.match(recheckAutoText('T14'), /故意按 y 放行/);
  assert.match(recheckAutoText('T14'), /不会因此困住你/);
});
