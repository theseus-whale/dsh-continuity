import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTurnPingHost } from '../src/turn-ping/host.mjs';
import { writeBase, activate } from '../src/fullseed/storage.mjs';
import { clearActiveCache } from '../src/fullseed/cache.mjs';
import { encodeRecallCursor } from '../src/turn-ping/retrieval-prototype.mjs';

test('beforeSeq filters seqEnd independently of the fullseed activation checkpoint', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-beforeseq-'));
  const sessionId = 'beforeseq-regression';
  const root = path.join(home, 'sessions', sessionId, 'turn-ping', 'fullseed');
  const checkpoint = 12000;
  const rows = [
    { id: 'origin', seqStart: 10495, seqEnd: 10503, text: '规则文件由用户维护而插件只读', vector: [1, 0] },
    { id: 'later', seqStart: 10504, seqEnd: 10510, text: '后续规则文件整理', vector: [0.95, Math.sqrt(1 - 0.95 ** 2)] },
  ];
  const summaries = rows.map((entry, index) => ({
    sessionId,
    turnId: `turn-${entry.id}`,
    chunkId: (index + 1).toString(16).padStart(64, '0'),
    chunkIndex: index,
    seqStart: entry.seqStart,
    seqEnd: entry.seqEnd,
    rawTextSha256: `raw-${entry.id}`,
    rawRecordSha256: `record-${entry.id}`,
    sourceViewSha256: `source-${entry.id}`,
    availableCutoff: checkpoint,
    snapshotBoundary: checkpoint,
    summaryText: entry.text,
  }));
  writeBase(root, {
    baseId: 'base-beforeseq-regression',
    summaries,
    vectors: rows.map(entry => entry.vector),
    identity: 'beforeseq-regression',
    checkpoint,
    snapshotBoundary: checkpoint,
  });
  activate(root, {
    baseId: 'base-beforeseq-regression',
    identity: 'beforeseq-regression',
    checkpoint,
    snapshotBoundary: checkpoint,
    pending: 0,
  });
  clearActiveCache();

  const host = createTurnPingHost({
    home,
    config: {
      enabled: true,
      boundaries: { allowDefaultEnable: true },
      rawIndex: { enabled: false },
      vector: { dimensions: 2 },
      retrieval: { prototype: { enabled: true, noveltyThreshold: 1 } },
    },
    embedder: async () => [1, 0],
  });

  const excluded = await host.beforeAnswer({ sessionId, query: '规则文件', cutoff: checkpoint, events: [], beforeSeq: 10500 });
  assert.equal(excluded.H, 0);

  const boundary = await host.beforeAnswer({ sessionId, query: '规则文件', cutoff: checkpoint, events: [], beforeSeq: 10504 });
  assert.equal(boundary.H, 1);
  assert.match(boundary.ping.text, /seq 10495-10503/);
  assert.doesNotMatch(boundary.ping.text, /seq 10504-10510/);
  assert.equal(boundary.retrieval.cutoff, checkpoint);

  const wider = await host.beforeAnswer({ sessionId, query: '规则文件', cutoff: checkpoint, events: [], beforeSeq: 12000 });
  assert.equal(wider.H, 2);
  assert.match(wider.ping.text, /seq 10495-10503/);
  assert.match(wider.ping.text, /seq 10504-10510/);

  const cursor = encodeRecallCursor({
    query: '规则文件',
    indexIdentity: 'beforeseq-regression',
    checkpoint,
    cutoff: checkpoint,
    beforeSeq: 12000,
    offset: 1,
    explorationIds: [summaries[0].chunkId],
  });
  const next = await host.beforeAnswer({
    sessionId,
    query: '规则文件',
    cutoff: checkpoint + 100,
    events: [],
    cursor,
    beforeSeq: 12000,
  });
  assert.equal(next.retrieval.cutoff, checkpoint);
  assert.equal(next.retrieval.prototype.offset, 1);
  assert.equal(next.H, 1);
  assert.doesNotMatch(next.ping.text, /seq 10495-10503/);
  assert.match(next.ping.text, /seq 10504-10510/);
});
