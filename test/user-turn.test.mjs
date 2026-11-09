import test from 'node:test';
import assert from 'node:assert/strict';
import {
  latestUserTurnFromSession,
  messageSourceKind,
} from '../src/user-turn.mjs';

const user = (text, kind = 'user') => ({
  type: 'user/message',
  data: { source: { kind }, content: [{ type: 'text', text }] },
});
const spliced = (items) => ({
  type: 'agent/inbox/spliced',
  data: { inserted: items },
});
const sessionOf = (events) => ({
  surface: { nodes: events.map((_, index) => index + 1) },
  eventAt: (seq) => events[seq - 1],
});

test('time-context and runtime-context are not the last user message', () => {
  const session = sessionOf([
    user('real user'),
    user('Time sampled while preparing', 'time-context'),
  ]);
  const turn = latestUserTurnFromSession(session);
  assert.equal(turn.text, 'real user');
});

test('a spliced gate notice is skipped, but a spliced user message is used', () => {
  const session = sessionOf([
    user('real user'),
    spliced([
      { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '[闸] TAG：' }] },
      { source: { kind: 'user' }, content: [{ type: 'text', text: 'spliced user' }] },
    ]),
  ]);
  assert.equal(latestUserTurnFromSession(session).text, 'spliced user');
});

test('only non-user context yields null', () => {
  const session = sessionOf([
    user('Current runtime context.', 'runtime-context'),
    spliced([{ source: { kind: 'time-context' }, content: [{ type: 'text', text: 'time' }] }]),
  ]);
  assert.equal(latestUserTurnFromSession(session), null);
});

test('messageSourceKind prefers data.message.source and falls back to data.source', () => {
  assert.equal(messageSourceKind({ data: { message: { source: { kind: 'user' } } } }), 'user');
  assert.equal(messageSourceKind({ data: { source: { kind: 'time-context' } } }), 'time-context');
  assert.equal(messageSourceKind({}), null);
});
