import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  activeCallIds,
  activePinSeqs,
  compressionBudget,
  handleNonTextToolResult,
  isImageToolResult,
  isNonPreviewableBlocks,
  nonTextInfo,
  oldestPinIndex,
  pauseActiveToolResult,
  previewBlocks,
  previewSummaryInput,
  previewToolResultEvent,
  targetFractionFor,
  toolCallMap,
} from '../src/tool-preview.mjs';

const longText = 'A'.repeat(900) + 'B'.repeat(600) + 'C'.repeat(500);
const textBlocks = (text) => [{ type: 'text', text }];
const toolResult = (seq, text, callId = 'call-1') => ({
  seq,
  type: 'tool/result',
  data: { message: { role: 'tool', source: { callId }, content: textBlocks(text) } },
});
const assistantWithCall = (seq, callId = 'call-1') => ({
  seq,
  type: 'assistant/message',
  data: { message: { role: 'assistant', content: [
    { type: 'reasoning', text: 'think' },
    { type: 'tool-call', id: callId, name: 'read', arguments: '{}' },
  ] } },
});

test('activeCallIds pins the open turn and every unpaired call', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/call', data: { turn: 1, callId: 'closed' } },
    toolResult(3, 'x', 'closed'),
    { type: 'tool/call', data: { turn: 1, callId: 'orphan' } },
    { type: 'turn/end', data: { turn: 1 } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'tool/call', data: { turn: 2, callId: 'open' } },
  ];
  assert.deepEqual([...activeCallIds(events)].sort(), ['open', 'orphan']);
});

test('activeCallIds does not pin a completed call in the open turn', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/call', data: { turn: 1, callId: 'done' } },
    toolResult(3, 'x', 'done'),
    { type: 'tool/call', data: { turn: 1, callId: 'in-flight' } },
  ];
  assert.deepEqual([...activeCallIds(events)].sort(), ['in-flight']);
});

test('activeCallIds without an open turn keeps only unpaired calls', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/call', data: { turn: 1, callId: 'done' } },
    toolResult(3, 'x', 'done'),
    { type: 'tool/call', data: { turn: 1, callId: 'pending' } },
    { type: 'turn/end', data: { turn: 1 } },
  ];
  assert.deepEqual([...activeCallIds(events)], ['pending']);
});

test('activeCallIds ignores unpaired calls older than the recent-turn buffer', () => {
  const events = [];
  for (let turn = 1; turn <= 5; turn += 1) {
    events.push({ type: 'turn/start', data: { turn } });
    events.push({ type: 'tool/call', data: { turn, callId: `old-${turn}` } });
    events.push({ type: 'turn/end', data: { turn } });
  }
  assert.deepEqual([...activeCallIds(events, { recentTurns: 3 })].sort(), ['old-3', 'old-4', 'old-5']);
  assert.deepEqual([...activeCallIds(events, { recentTurns: 5 })].sort(), [
    'old-1', 'old-2', 'old-3', 'old-4', 'old-5',
  ]);
});

test('activePinSeqs pins the assistant tool-call message and its result only', () => {
  const bySeq = new Map([
    [1, { type: 'system/message', data: {} }],
    [2, assistantWithCall(2, 'call-a')],
    [3, toolResult(3, 'result a', 'call-a')],
    [4, { type: 'user/message', data: { content: textBlocks('hi') } }],
    [5, assistantWithCall(5, 'call-b')],
    [6, toolResult(6, 'result b', 'call-b')],
  ]);
  const pins = activePinSeqs([1, 2, 3, 4, 5, 6], (seq) => bySeq.get(seq), new Set(['call-a']));
  assert.deepEqual([...pins], [2, 3]);
  assert.equal(oldestPinIndex([1, 2, 3, 4, 5, 6], pins), 1);
  assert.equal(oldestPinIndex([1, 2], new Set()), -1);
});

test('previewBlocks keeps head and tail and cites the original seq', () => {
  const preview = previewBlocks(textBlocks(longText), { originalSeq: 42 });
  assert.ok(preview);
  assert.ok(preview.charsAfter < preview.charsBefore);
  assert.ok(preview.charsAfter <= 1280);
  assert.ok(preview.content[0].text.startsWith('A'));
  assert.ok(preview.content[0].text.endsWith('C'));
  assert.match(preview.content[0].text, /session_log get seq=42/);
  assert.match(preview.content[0].text, /omitted \d+ chars/);
});

test('previewBlocks skips short and non-text content', () => {
  assert.equal(previewBlocks(textBlocks('short')), null);
  assert.equal(previewBlocks([{ type: 'image', source: {} }]), null);
  assert.equal(previewBlocks([]), null);
});

test('previewToolResultEvent produces a frozen replacement without mutating the original', () => {
  const event = toolResult(7, longText, 'call-x');
  Object.freeze(event.data.message.content[0]);
  const preview = previewToolResultEvent(event, 7);
  assert.ok(preview);
  assert.equal(preview.charsBefore, longText.length);
  assert.equal(preview.message.role, 'tool');
  assert.notEqual(preview.message, event.data.message);
  assert.equal(event.data.message.content[0].text, longText);
  assert.ok(Object.isFrozen(preview.message));
  assert.equal(previewToolResultEvent({ type: 'user/message', data: {} }, 1), null);
});

test('previewSummaryInput previews only tool messages and keeps human text intact', () => {
  const input = {
    tools: [{ name: 'read' }],
    messages: [
      { role: 'system', content: textBlocks('system') },
      { role: 'user', content: textBlocks('human words') },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'why' }] },
      { role: 'tool', content: textBlocks(longText) },
    ],
  };
  const view = previewSummaryInput(input, { header: '[gist · log:s#seq=1-2]' });
  assert.notEqual(view, input);
  assert.equal(view.messages[0], input.messages[0]);
  assert.equal(view.messages[1], input.messages[1]);
  assert.equal(view.messages[2], input.messages[2]);
  assert.notEqual(view.messages[3], input.messages[3]);
  assert.match(view.messages[3].content[0].text, /tool result preview/);
  assert.match(view.messages[3].content[0].text, /\[gist/);
  assert.equal(input.messages[3].content[0].text, longText);
  assert.equal(previewSummaryInput(input, { header: 'x' }) !== input, true);
});

test('previewSummaryInput is a no-op when no tool result is long', () => {
  const input = { messages: [{ role: 'tool', content: textBlocks('short') }] };
  assert.equal(previewSummaryInput(input), input);
  const invalid = { messages: 'no' };
  assert.equal(previewSummaryInput(invalid), invalid);
});

test('compression targets low for band-high and emergencyTo for emergency', () => {
  const policy = { low: 0.62, emergencyTo: 0.80, maxPerBatch: 190000, minAction: 24000 };
  const W = 792576;
  assert.equal(targetFractionFor('band-high', policy), 0.62);
  assert.equal(targetFractionFor('emergency', policy), 0.80);
  assert.equal(targetFractionFor('setpoint', policy), null);
  assert.equal(compressionBudget({ reason: 'band-high', estTokens: 681615, windowTokens: W, policy }), 190000);
  // After a preview drops below high, the pass still continues to low.
  const afterPreview = compressionBudget({ reason: 'band-high', estTokens: 600000, windowTokens: W, policy });
  assert.ok(Math.abs(afterPreview - 108602.88) < 1e-6);
  assert.equal(compressionBudget({ reason: 'band-high', estTokens: 491397, windowTokens: W, policy }), 0);
  // A sliver left after the preview is not worth another prefix rewrite.
  assert.equal(compressionBudget({ reason: 'band-high', estTokens: 495000, windowTokens: W, policy }), 0);
  const emergency = compressionBudget({ reason: 'emergency', estTokens: 768799, windowTokens: W, policy });
  assert.ok(Math.abs(emergency - 134738.2) < 1e-6);
  assert.equal(compressionBudget({ reason: 'emergency', estTokens: 634060.8, windowTokens: W, policy }), 0);
  assert.equal(compressionBudget({ reason: 'setpoint', estTokens: 700000, windowTokens: W, policy }), 0);
});

test('non-text tool results become a semantic handle, original content untouched', () => {
  const event = {
    seq: 9,
    type: 'tool/result',
    data: { message: {
      role: 'tool',
      source: { callId: 'call-img' },
      content: [
        { type: 'text', text: 'a screenshot caption' },
        { type: 'image', attachment: { name: 'shot.png', size: 1234 } },
      ],
    } },
  };
  const info = nonTextInfo(event);
  assert.deepEqual(info.types, ['image']);
  assert.deepEqual(info.names, ['shot.png']);
  assert.equal(info.bytes, 1234);
  assert.equal(info.text, 'a screenshot caption');
  assert.equal(isImageToolResult(event), true);

  const handle = handleNonTextToolResult(event, 9, {
    toolName: 'view',
    toolArgs: '{"path":"shot.png"}',
    semantic: { topic: 'UI screenshot', function: 'visual check', importance: 'high', caveats: 'PNG only', summary: 'Shows the panel.' },
  });
  assert.ok(handle);
  assert.match(handle.message.content[0].text, /seq=9/);
  assert.match(handle.message.content[0].text, /shot.png/);
  assert.match(handle.message.content[0].text, /importance: high/);
  assert.match(handle.message.content[0].text, /Shows the panel/);
  assert.match(handle.message.content[0].text, /original archived/);
  assert.equal(event.data.message.content[1].type, 'image');
  assert.ok(Object.isFrozen(handle.message));

  assert.equal(handleNonTextToolResult(toolResult(10, 'plain'), 10), null);
});

test('oversized images fall back to the non-text handle', () => {
  const event = {
    seq: 12,
    type: 'tool/result',
    data: { message: {
      role: 'tool',
      source: { callId: 'call-big-image' },
      content: [{ type: 'image', attachment: { name: 'huge.png', size: 5 * 1024 * 1024 } }],
    } },
  };
  assert.equal(isImageToolResult(event), false);
  assert.ok(handleNonTextToolResult(event, 12));
});

test('path-only images derive bytes from stat and remain inline', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-image-')), 'page-01.jpg');
  fs.writeFileSync(file, Buffer.alloc(24_980, 0x41));
  const event = {
    seq: 13,
    type: 'tool/result',
    data: { message: {
      role: 'tool',
      source: { callId: 'call-read-image' },
      content: [{ type: 'image', name: 'page-01.jpg', path: file }],
    } },
  };
  assert.equal(nonTextInfo(event).bytes, 24_980);
  assert.equal(isImageToolResult(event), true);
});

test('nonTextInfo reads image blocks from data.content', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-image-')), 'page-02.jpg');
  fs.writeFileSync(file, Buffer.alloc(1_234, 0x41));
  const event = {
    seq: 14,
    type: 'tool/result',
    data: { content: [{ type: 'image', name: 'page-02.jpg', path: file }] },
  };
  assert.equal(nonTextInfo(event).bytes, 1_234);
  assert.equal(isImageToolResult(event), true);
});

test('pauseActiveToolResult is a text tool result that cites the original', () => {
  const event = toolResult(11, 'x'.repeat(5000), 'call-big');
  const pause = pauseActiveToolResult(event, 11, { toolName: 'read', callId: 'call-big' });
  assert.match(pause.handle, /continuity pause/);
  assert.match(pause.handle, /call-big/);
  assert.match(pause.handle, /seq=11/);
  assert.match(pause.handle, /Do not retry/);
  assert.equal(pause.message.content[0].type, 'text');
  assert.equal(event.data.message.content[0].text.length, 5000);
});

test('toolCallMap indexes call metadata for handles', () => {
  const map = toolCallMap([
    { type: 'tool/call', data: { callId: 'c1', name: 'read', arguments: '{"p":1}', turn: 3 } },
    { type: 'tool/call', data: { callId: 'c2', name: 'view', arguments: '{}', turn: 3 } },
  ]);
  assert.deepEqual(map.get('c1'), { name: 'read', arguments: '{"p":1}', turn: 3 });
  assert.equal(map.get('missing'), undefined);
});

test('handles, pauses, and existing previews are never previewed again', () => {
  const handleText = `[tool result handle · seq=12]\nsummary: important\n${longText}`;
  const handleEvent = toolResult(12, handleText, 'call-handle');
  assert.equal(isNonPreviewableBlocks(textBlocks(handleText)), true);
  assert.equal(previewToolResultEvent(handleEvent, 12), null);
  const input = { messages: [{ role: 'tool', content: textBlocks(handleText) }] };
  assert.equal(previewSummaryInput(input), input);

  const pauseText = `[continuity pause · call=call-pause]\n${longText}`;
  assert.equal(previewToolResultEvent(toolResult(13, pauseText), 13), null);
  assert.equal(isNonPreviewableBlocks(textBlocks(pauseText)), true);

  const previewText = `head\n\n[... tool result preview: omitted 100 chars; original ...]\n\n${longText}`;
  assert.equal(isNonPreviewableBlocks(textBlocks(previewText)), true);
  assert.equal(previewToolResultEvent(toolResult(14, previewText), 14), null);
});
