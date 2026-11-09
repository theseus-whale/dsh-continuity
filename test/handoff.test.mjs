import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readAssetIndex } from '../src/assets.mjs';
import { normalizeHandoff, writeHandoff } from '../src/handoff.mjs';
import { createHandoffTool } from '../src/handoff-tool.mjs';

const ENVELOPE = {
  childSessionId: 'child-1',
  runId: 'run-1',
  summary: 'Scanned 20 files; found 3 candidates.',
  decisions: ['candidate B rejected: stale schema'],
  open: ['verify candidate C'],
  artifacts: ['assets/ptc/run-1/child-1/result.json'],
  sourceSeqs: [4, 9],
  confidence: 'high',
};

test('normalizeHandoff preserves the full envelope', () => {
  const normalized = normalizeHandoff(ENVELOPE);
  assert.equal(normalized.childSessionId, 'child-1');
  assert.deepEqual(normalized.sourceSeqs, [4, 9]);
  assert.deepEqual(normalized.decisions, ['candidate B rejected: stale schema']);
  assert.equal(normalized.confidence, 'high');
});

test('normalizeHandoff rejects missing identity and invalid confidence', () => {
  assert.throws(() => normalizeHandoff({ ...ENVELOPE, childSessionId: '' }), /childSessionId/);
  assert.throws(() => normalizeHandoff({ ...ENVELOPE, runId: '' }), /runId/);
  assert.throws(() => normalizeHandoff({ ...ENVELOPE, confidence: 'sure' }), /confidence/);
});

test('writeHandoff copies artifact bytes and stores a child artifact', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-handoff-'));
  const artifact = path.join(home, 'result.json');
  fs.writeFileSync(artifact, '{"ok":true}\n');
  const tool = createHandoffTool({ home });
  const text = await tool.execute({ ...ENVELOPE, artifacts: [artifact] }, { agent: { session: { id: 'parent' } } });
  assert.match(text, /\[ptc-handoff child=child-1 run=run-1 confidence=high\]/);
  assert.match(text, /\[asset-child session=child-1 run=run-1 seq=4 /);
  const rows = await readAssetIndex({ home, sessionId: 'parent' });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.owner === 'child'));
  const copied = rows.find((row) => row.name === 'result.json');
  assert.ok(copied);
  assert.equal(copied.mime, 'application/json');
  assert.equal(copied.seq, 5);
  const copiedPath = path.join(home, 'sessions', 'parent', copied.path);
  assert.equal(fs.readFileSync(copiedPath, 'utf8'), '{"ok":true}\n');
  const handoff = rows.find((row) => row.name === 'handoff.json');
  assert.equal(handoff.seq, 4);
  const envelope = JSON.parse(fs.readFileSync(path.join(home, 'sessions', 'parent', handoff.path), 'utf8'));
  assert.equal(envelope.artifactsResolved, true);
  assert.equal(envelope.artifacts[0], copied.path);
  assert.equal(envelope.artifactSources[0].sha256, copied.sha256);
  assert.equal(envelope.artifactSources[0].mime, 'application/json');
});

test('writeHandoff marks missing artifact paths as unresolved', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-handoff-'));
  const result = await writeHandoff({
    home,
    parentSessionId: 'parent',
    envelope: { ...ENVELOPE, artifacts: ['C:/definitely/missing.png'] },
  });
  assert.equal(result.envelope.artifactsResolved, false);
  assert.equal(result.envelope.artifacts.length, 0);
  assert.equal(result.envelope.unresolvedArtifacts[0].source, 'C:/definitely/missing.png');
});
