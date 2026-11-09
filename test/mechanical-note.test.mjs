import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMechanicalNote } from '../src/memory/mechanical-note.mjs';

test('renders user text, tool calls and receipts, and skips assistant prose', () => {
  const note = renderMechanicalNote({
    maxTokens: 400,
    header: 'gist header',
    messages: [
      { role: 'user', content: 'remember this' },
      { role: 'assistant', content: [{ type: 'tool-call', name: 'session_log', arguments: { get: 1 } }] },
      { role: 'tool', content: 'receipt text' },
      { role: 'assistant', content: 'assistant prose should disappear' },
    ],
  });
  assert.ok(note.text.includes('gist header'));
  assert.ok(note.text.includes('remember this'));
  assert.ok(note.text.includes('session_log'));
  assert.ok(note.text.includes('receipt text'));
  assert.ok(!note.text.includes('assistant prose should disappear'));
  assert.ok(note.chars <= 1600);
});

test('skips injected user text', () => {
  const note = renderMechanicalNote({
    maxTokens: 400,
    messages: [
      { role: 'user', content: '[规则] injected rules' },
      { role: 'user', content: 'real user line' },
      { role: 'user', content: '[创] peer decision' },
    ],
  });
  assert.ok(note.text.includes('real user line'));
  assert.ok(note.text.includes('## Peer'));
  assert.ok(!note.text.includes('[规则]'));
});
