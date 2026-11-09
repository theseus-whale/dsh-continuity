import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assetMarker,
  blockPayload,
  findAssetBySeq,
  readAssetIndex,
  sessionAssetsDir,
  writeAsset,
} from '../src/assets.mjs';

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=';

test('writes an inline image under session assets and indexes it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-assets-'));
  const block = { type: 'image', source: { data: PNG_1PX, media_type: 'image/png' }, name: 'pixel.png' };
  const result = await writeAsset({ home, sessionId: 'session-test', block, seq: 42 });
  assert.equal(result.ok, true);
  assert.match(result.row.path, /^assets\/parent\/image-42-[a-f0-9]{8}\.png$/);
  assert.equal(result.row.bytes, 68);
  assert.ok(fs.existsSync(path.join(sessionAssetsDir(home, 'session-test'), 'index.jsonl')));
  const rows = await readAssetIndex({ home, sessionId: 'session-test' });
  assert.equal(rows.length, 1);
  const found = await findAssetBySeq({ home, sessionId: 'session-test', seq: 42 });
  assert.equal(found[0].sha256, result.row.sha256);
  assert.match(assetMarker(found[0]), /^\[asset-parent seq=42 /);
  assert.match(assetMarker(found[0]), /path=assets\/parent\/image-42-/);
});

test('reuses an existing content-addressed file', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-assets-'));
  const block = { type: 'image', source: { data: PNG_1PX, media_type: 'image/png' } };
  const first = await writeAsset({ home, sessionId: 's', block, seq: 1 });
  const second = await writeAsset({ home, sessionId: 's', block, seq: 1 });
  assert.equal(first.row.sha256, second.row.sha256);
  assert.equal(first.absolute, second.absolute);
  assert.equal(fs.readdirSync(path.dirname(first.absolute)).filter((name) => name.endsWith('.png')).length, 1);
  assert.equal((await readAssetIndex({ home, sessionId: 's' })).length, 1);
});

test('reports no payload for size-only metadata', async () => {
  assert.equal(blockPayload({ type: 'image', attachment: { name: 'x.png', size: 10 } }), null);
  const result = await writeAsset({ home: os.tmpdir(), sessionId: 's', block: { type: 'image', size: 10 }, seq: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-payload');
});

test('resolves an attachmentId from the local attachment store', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-attachment-'));
  const previous = process.env.USERPROFILE;
  process.env.USERPROFILE = root;
  try {
    const digest = 'a'.repeat(64);
    const object = path.join(root, '.dsh', 'attachments', 'v1', 'objects', 'aa', digest);
    fs.mkdirSync(path.dirname(object), { recursive: true });
    fs.writeFileSync(object, Buffer.alloc(321, 0x42));
    const block = {
      type: 'image',
      attachment: {
        attachmentId: `sha256:${digest}`,
        mediaType: 'image/jpeg',
        bytes: 321,
        name: 'shot.jpg',
      },
    };
    assert.equal(blockPayload(block).buffer.length, 321);
    const result = await writeAsset({ home: path.join(root, 'continuity'), sessionId: 's', block, seq: 3 });
    assert.equal(result.ok, true);
    assert.equal(result.row.bytes, 321);
    assert.equal(result.row.mime, 'image/jpeg');
    assert.match(result.row.path, /\.jpg$/);
  } finally {
    if (previous === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previous;
  }
});
