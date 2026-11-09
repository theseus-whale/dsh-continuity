import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildIndex,
  getRange,
  grepRange,
  parsePointer,
  SessionLogError,
} from '../src/session-log.mjs';
import { writeChildAsset } from '../src/assets.mjs';
import { createSessionLogTool, apply } from '../src/session-log-tool.mjs';

const T0 = Date.UTC(2026, 9, 26, 10, 0, 0);

const events = [
  {
    type: 'system/message',
    seq: 0,
    time: T0,
    data: { turn: 0, step: 0, message: { role: 'system', content: [{ type: 'text', text: 'SYSTEM PROMPT mentions Blue Heron in a tool description.' }] } },
  },
  {
    type: 'user/message',
    seq: 1,
    time: T0 + 1_000,
    data: { role: 'user', content: [{ type: 'text', text: 'The project code name is Blue Heron, agreed on 2026-10-01.' }] },
  },
  {
    type: 'assistant/message',
    seq: 2,
    time: T0 + 2_000,
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'I will remember Blue Heron.' }] }, stream: [] },
  },
  {
    type: 'tool/result',
    seq: 3,
    time: T0 + 3_000,
    data: { turn: 1, step: 1, message: { role: 'tool', content: [{ type: 'text', text: 'tool output: Blue Heron checked.' }] } },
  },
  {
    type: 'compaction/summary',
    seq: 4,
    time: T0 + 4_000,
    data: {
      compactionId: 'c1',
      shadowedRange: { start: 1, end: 3 },
      shadowedSeqs: [1, 2, 3],
      shadowedTokenCount: 123,
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      summary: [{
        type: 'text',
        text: '[gist · log:session-test#seq=1-3 · 3 messages · original retrievable via session_log]\n## Summary\nBlue Heron.',
      }],
    },
  },
  {
    type: 'user/message',
    seq: 5,
    time: T0 + 5_000,
    data: { role: 'user', content: [{ type: 'text', text: 'What date was Blue Heron agreed?' }] },
  },
  {
    type: 'compaction/summary',
    seq: 6,
    time: T0 + 6_000,
    data: {
      compactionId: 'c2',
      shadowedRange: { start: 5, end: 2 },
      shadowedSeqs: [5, 2],
      shadowedTokenCount: 50,
      summary: [{
        type: 'text',
        text: '[gist · log:session-test#seq=5-2 · 2 messages · original retrievable via session_log]\n## Summary\nlater.',
      }],
    },
  },
];

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function snapshot() {
  return JSON.stringify(events);
}

test('index lists gist ranges newest first with pointers', () => {
  const result = buildIndex({ sessionId: 'session-test', events });
  assert.equal(result.total, 2);
  assert.equal(result.returned, 2);
  assert.match(result.text, /gists=2/);
  assert.match(result.text, /seq=6 .*surface 5-2 .*2 msgs/);
  assert.match(result.text, /seq=4 .*surface 1-3 .*3 msgs/);
  assert.ok(result.text.indexOf('seq=6') < result.text.indexOf('seq=4'));
  assert.match(result.text, /original retrievable via session_log/);
});

test('index without gists points to grep then get', () => {
  const result = buildIndex({ sessionId: 'session-test', events: events.slice(0, 3) });
  assert.equal(result.total, 0);
  assert.match(result.text, /no gist records/);
  assert.match(result.text, /grep/);
  assert.match(result.text, /get <seq>/);
});

test('get one seq returns the raw text', () => {
  const result = getRange({ sessionId: 'session-test', events, seq: 1 });
  assert.equal(result.total, 1);
  assert.match(result.text, /The project code name is Blue Heron/);
  assert.match(result.text, /agreed on 2026-10-01/);
});

test('get attaches an asset marker for a registered seq', () => {
  const result = getRange({
    sessionId: 'session-test',
    events,
    seq: 1,
    assets: [{
      seq: 1,
      path: 'assets/parent/image-1-a1b2c3d4.png',
      mime: 'image/png',
      bytes: 68,
    }],
  });
  assert.match(result.text, /\[asset-parent seq=1 /);
  assert.match(result.text, /path=assets\/parent\/image-1-a1b2c3d4\.png/);
});

test('get a gist range resolves the exact shadowed seqs and surface order', () => {
  const normal = getRange({ sessionId: 'session-test', events, start: 1, end: 3 });
  assert.equal(normal.total, 3);
  assert.match(normal.text, /resolved via gist c1/);
  assert.match(normal.text, /roles: user:1 assistant:1 tool:1/);

  const nonMonotonic = getRange({ sessionId: 'session-test', events, start: 5, end: 2 });
  assert.equal(nonMonotonic.total, 2);
  assert.match(nonMonotonic.text, /resolved via gist c2/);
  assert.ok(nonMonotonic.text.indexOf('seq=5') < nonMonotonic.text.indexOf('seq=2'));
});

test('get accepts seq ± context', () => {
  const result = getRange({ sessionId: 'session-test', events, seq: 2, context: 1 });
  assert.equal(result.total, 3);
  assert.match(result.text, /seq=1 \[user\]/);
  assert.match(result.text, /seq=2 \[assistant\]/);
  assert.match(result.text, /seq=3 \[tool\]/);
});

test('get reports out-of-range and empty ranges without inventing content', () => {
  assert.throws(
    () => getRange({ sessionId: 'session-test', events, seq: 99 }),
    (error) => error instanceof SessionLogError && error.code === 'SEQ_NOT_FOUND'
      && /only remember the gist/.test(error.message),
  );
  assert.throws(
    () => getRange({ sessionId: 'session-test', events, start: 10, end: 12 }),
    (error) => error instanceof SessionLogError && error.code === 'RANGE_EMPTY'
      && /only remember the gist/.test(error.message),
  );
  assert.throws(
    () => getRange({ sessionId: 'session-test', events, start: 4, end: 2 }),
    (error) => error instanceof SessionLogError && error.code === 'RANGE_ORDER',
  );
  assert.throws(
    () => getRange({ sessionId: 'session-test', events }),
    (error) => error instanceof SessionLogError && error.code === 'RANGE_REQUIRED',
  );
});

test('get truncates a large range with a manifest and next seq', () => {
  const result = getRange({ sessionId: 'session-test', events, start: 1, end: 3, limit: 1 });
  assert.equal(result.total, 3);
  assert.equal(result.returned, 1);
  assert.equal(result.truncated, true);
  assert.match(result.text, /\[truncated: showing 1 of 3; next seq=2/);
  assert.match(result.text, /roles: user:1 assistant:1 tool:1/);
});

test('grep is case-insensitive, returns seqs, and excludes the system prompt', () => {
  const result = grepRange({ sessionId: 'session-test', events, query: 'blue heron' });
  assert.equal(result.total, 5);
  assert.match(result.text, /matches=5/);
  assert.match(result.text, /seq=1 \[user\]/);
  assert.match(result.text, /seq=4 \[gist\]/);
  assert.doesNotMatch(result.text, /seq=0 \[system\]/);
  assert.ok(result.text.indexOf('seq=1') < result.text.indexOf('seq=5'));
});

test('grep limit and context', () => {
  const limited = grepRange({ sessionId: 'session-test', events, query: 'Blue Heron', limit: 2 });
  assert.equal(limited.total, 5);
  assert.equal(limited.returned, 2);
  assert.equal(limited.truncated, true);
  assert.match(limited.text, /\[truncated: showing 2 of 5/);

  const contextual = grepRange({ sessionId: 'session-test', events, query: 'date', context: 1 });
  assert.match(contextual.text, /seq=5 \[user\]/);
  assert.match(contextual.text, /before seq=4 \[gist\]/);
});

test('grep no matches says the original may be unavailable', () => {
  const result = grepRange({ sessionId: 'session-test', events, query: 'No Such Phrase' });
  assert.equal(result.total, 0);
  assert.match(result.text, /no matches/);
  assert.match(result.text, /only remember the gist/);
});

test('parsePointer handles plain ids, pointers, and full gist headers', () => {
  assert.deepEqual(parsePointer('session-test'), {
    sessionId: 'session-test', start: null, end: null, pointer: false,
  });
  assert.deepEqual(parsePointer('log:session-test#seq=3005-1872'), {
    sessionId: 'session-test', start: 3005, end: 1872, pointer: true,
  });
  assert.deepEqual(parsePointer('[gist · log:session-test#seq=1-3 · 3 messages · original retrievable via session_log]'), {
    sessionId: 'session-test', start: 1, end: 3, pointer: true,
  });
});

test('retrieval is read-only over frozen events', () => {
  const frozen = deepFreeze(events);
  const before = snapshot();
  buildIndex({ sessionId: 'session-test', events: frozen });
  getRange({ sessionId: 'session-test', events: frozen, start: 1, end: 3 });
  grepRange({ sessionId: 'session-test', events: frozen, query: 'Blue Heron' });
  assert.equal(snapshot(), before);
});

test('tool definition: index/get/grep through a fake sessionQuery', async () => {
  const reads = [];
  const tool = createSessionLogTool({
    sessionQuery: {
      async readSession(id) {
        reads.push(id);
        return { events };
      },
    },
  });
  const signal = new AbortController().signal;
  const exec = { agent: { id: 'session-test' }, signal };

  const index = await tool.execute({ action: 'index' }, exec);
  assert.match(index, /session_log index · session=session-test/);
  assert.match(index, /gists=2/);

  const got = await tool.execute({ action: 'get', session: 'log:session-test#seq=5-2' }, exec);
  assert.match(got, /resolved via gist c2/);
  assert.match(got, /What date was Blue Heron agreed/);

  const grep = await tool.execute({ action: 'grep', query: 'Blue Heron', context: 1 }, exec);
  assert.match(grep, /session_log grep/);
  assert.match(grep, /seq=1 \[user\]/);

  assert.deepEqual(reads, ['session-test', 'session-test', 'session-test']);
  assert.equal(tool.name, 'session_log');
  assert.equal(tool.output.render(null, 'hello')[0].text, 'hello');
});

test('tool definition surfaces session failures with the only-gist fallback', async () => {
  const tool = createSessionLogTool({
    sessionQuery: {
      async readSession() {
        throw new Error('SESSION_NOT_FOUND');
      },
    },
  });
  await assert.rejects(
    () => tool.execute({ action: 'index' }, { agent: { id: 'missing' }, signal: new AbortController().signal }),
    /cannot read session missing.*only remember the gist/,
  );
  await assert.rejects(
    () => tool.execute({ action: 'nope' }, { agent: { id: 'session-test' }, signal: new AbortController().signal }),
    /action must be/,
  );
});

test('index lists parent-visible child assets for child_asset discovery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-child-index-'));
  const previous = process.env.USERPROFILE;
  process.env.USERPROFILE = root;
  try {
    const home = path.join(root, '.dsh', 'continuity');
    await writeChildAsset({
      home,
      parentSessionId: 'session-test',
      childSessionId: 'child-1',
      runId: 'run-1',
      block: {
        type: 'image',
        source: {
          data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=',
          media_type: 'image/png',
        },
      },
      seq: 4,
    });
    const tool = createSessionLogTool({
      sessionQuery: { async readSession() { return { events }; } },
    });
    const text = await tool.execute({ action: 'index' }, { agent: { id: 'session-test' } });
    assert.match(text, /child assets \(use child_asset\)/);
    assert.match(text, /\[asset-child session=child-1 run=run-1 seq=4 /);
  } finally {
    if (previous === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previous;
  }
});

test('preset-scoped apply registers session_log through ctx.tools', () => {
  const registered = [];
  const ctx = {
    sessionQuery: { async readSession() { return { events }; } },
    tools: {
      register(tool) {
        registered.push(tool);
        return () => {};
      },
    },
    effect(execute) {
      return execute();
    },
  };
  apply(ctx);
  assert.equal(registered.length, 4);
  assert.deepEqual(
    registered.map((tool) => tool.name),
    ['session_log', 'session_asset', 'child_asset', 'ptc_handoff'],
  );
  assert.deepEqual(registered[0].parameters.required, ['action']);
  assert.equal(registered[0].output.render(null, 'x')[0].text, 'x');
});
