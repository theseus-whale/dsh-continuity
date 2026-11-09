import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeAsset, writeChildAsset } from '../src/assets.mjs';
import { createChildAssetTool, createSessionAssetTool } from '../src/asset-tool.mjs';

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=';

test('session_asset gets a parent asset by seq', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-asset-tool-'));
  const block = { type: 'image', source: { data: PNG_1PX, media_type: 'image/png' } };
  const written = await writeAsset({ home, sessionId: 'session-test', block, seq: 42 });
  const tool = createSessionAssetTool({ home });
  const text = await tool.execute({ action: 'get', seq: 42 }, { agent: { session: { id: 'session-test' } } });
  assert.match(text, /\[asset-parent seq=42 /);
  assert.match(text, new RegExp(written.row.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(text, /absolute=/);
});

test('session_asset lists and refuses unknown seq', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-asset-tool-'));
  const block = { type: 'image', source: { data: PNG_1PX, media_type: 'image/png' } };
  await writeAsset({ home, sessionId: 's', block, seq: 7 });
  const tool = createSessionAssetTool({ home });
  const list = await tool.execute({ action: 'list' }, { agent: { session: { id: 's' } } });
  assert.match(list, /assets=1/);
  const missing = await tool.execute({ action: 'get', seq: 999 }, { agent: { session: { id: 's' } } });
  assert.match(missing, /no registered asset/);
});

test('session_asset recovers a parent image from raw session data.content', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-parent-recover-'));
  const events = [{
    seq: 21,
    type: 'user/message',
    data: { content: [{
      type: 'image',
      source: { data: PNG_1PX, media_type: 'image/png' },
      attachment: { mediaType: 'image/png', bytes: 68, name: 'upload.png' },
    }] },
  }];
  const tool = createSessionAssetTool({
    home,
    sessionQuery: { async readSession() { return { events }; } },
  });
  const text = await tool.execute({ action: 'get', seq: 21 }, { agent: { session: { id: 'parent' } } });
  assert.match(text, /recovered from raw seq=21/);
  assert.match(text, /\[asset-parent seq=21 /);
  assert.match(text, /path=assets\/parent\/image-21-/);
});

test('child_asset gets a PTC child artifact under the parent index', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-child-asset-'));
  const block = { type: 'image', source: { data: PNG_1PX, media_type: 'image/png' } };
  await writeChildAsset({
    home,
    parentSessionId: 'parent',
    childSessionId: 'child-1',
    runId: 'run-1',
    block,
    seq: 5,
  });
  const tool = createChildAssetTool({ home });
  const text = await tool.execute(
    { action: 'get', childSessionId: 'child-1', runId: 'run-1', seq: 5 },
    { agent: { session: { id: 'parent' } } },
  );
  assert.match(text, /\[asset-child session=child-1 run=run-1 seq=5 /);
  assert.match(text, /path=assets\/ptc\/run-1\/child-1\/image-5-/);
  const list = await tool.execute({ action: 'list', childSessionId: 'child-1' }, { agent: { session: { id: 'parent' } } });
  assert.match(list, /assets=1/);
});

test('child_asset recovers an unregistered image from the child session', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-child-recover-'));
  const childEvents = [{
    seq: 9,
    type: 'tool/result',
    data: { message: { role: 'tool', content: [{
      type: 'image',
      source: { data: PNG_1PX, media_type: 'image/png' },
    }] } },
  }];
  const tool = createChildAssetTool({
    home,
    sessionQuery: { async readSession() { return { events: childEvents }; } },
  });
  const text = await tool.execute(
    { action: 'get', childSessionId: 'child-9', runId: 'run-9', seq: 9 },
    { agent: { session: { id: 'parent' } } },
  );
  assert.match(text, /recovered from child=child-9/);
  assert.match(text, /\[asset-child session=child-9 run=run-9 seq=9 /);
});
