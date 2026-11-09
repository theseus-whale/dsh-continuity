import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWindowSummary } from '../src/memory/window-summary.mjs';

function event(seq, type, data = {}) {
  return { seq, type, time: 1_700_000_000_000 + seq, data };
}

test('builds a capped window summary and keeps raw pointers', () => {
  const events = [
    event(10, 'user/message', { content: [{ type: 'text', text: 'user asks A' }] }),
    event(11, 'assistant/message', { content: [{ type: 'text', text: 'assistant does B' }] }),
    event(12, 'tool/call', { name: 'session_log' }),
    event(13, 'user/message', { content: [{ type: 'text', text: 'x'.repeat(5000) }] }),
  ];
  const summary = buildWindowSummary({ events, fromSeq: 10, toSeq: 13, maxTokens: 800 });
  assert.equal(summary.fromSeq, 10);
  assert.equal(summary.toSeq, 13);
  assert.ok(summary.text.includes('## 窗口 seq 10-13'));
  assert.ok(summary.text.includes('session_log'));
  assert.ok(summary.chars <= 3200);
  assert.ok(summary.approxTokens <= 800);
  assert.equal(summary.kind, 'window-extractive');
  assert.equal(summary.quality, 'extractive');
});

test('ignores events outside the window', () => {
  const summary = buildWindowSummary({
    events: [
      event(1, 'user/message', { content: [{ type: 'text', text: 'outside' }] }),
      event(5, 'user/message', { content: [{ type: 'text', text: 'inside' }] }),
    ],
    fromSeq: 5,
    toSeq: 5,
  });
  assert.ok(summary.text.includes('inside'));
  assert.ok(!summary.text.includes('outside'));
});

test('skips injected continuity and system reminders', () => {
  const summary = buildWindowSummary({
    events: [
      event(1, 'user/message', { content: [{ type: 'text', text: '[continuity:fold] noisy' }] }),
      event(2, 'user/message', { content: [{ type: 'text', text: '<system-reminder> noisy' }] }),
      event(3, 'user/message', { content: [{ type: 'text', text: 'Current runtime context. noisy' }] }),
      event(4, 'user/message', { content: [{ type: 'text', text: 'Time sampled while preparing turn 1. noisy' }] }),
      event(6, 'user/message', { content: [{ type: 'text', text: '[规则] Continuity rules noisy' }] }),
      event(7, 'user/message', { content: [{ type: 'text', text: '[创] peer quoting [规则] noisy' }] }),
      event(5, 'user/message', { content: [{ type: 'text', text: 'real user line' }] }),
    ],
    fromSeq: 1,
    toSeq: 7,
  });
  assert.ok(summary.text.includes('real user line'));
  assert.ok(!summary.text.includes('[continuity:fold]'));
  assert.ok(!summary.text.includes('<system-reminder>'));
  assert.ok(!summary.text.includes('Current runtime context'));
  assert.ok(!summary.text.includes('Time sampled while preparing'));
  assert.ok(!summary.text.split('\n').some((line) => line.startsWith('- seq') && line.includes('[规则]')));
  assert.ok(summary.text.includes('## 同伴'));
  assert.ok(summary.text.includes('(peer) seq 7'));
});

