import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const nowIso = () => new Date().toISOString();

export function acquireLock(root, { pid = process.pid, now = Date.now(), heartbeatMs = 30_000 } = {}) {
  fs.mkdirSync(root, { recursive: true });
  const lockPath = path.join(root, 'lock.json');
  const body = { owner: `${pid}:${randomUUID()}`, pid, nonce: randomUUID(), acquiredAt: nowIso(), heartbeatAt: nowIso() };
  try {
    fs.writeFileSync(lockPath, JSON.stringify(body), { encoding: 'utf8', flag: 'wx' });
    const timer = setInterval(() => {
      try {
        const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (current.nonce === body.nonce) fs.writeFileSync(lockPath, JSON.stringify({ ...current, heartbeatAt: nowIso() }), 'utf8');
      } catch { /* keep lock handling explicit */ }
    }, heartbeatMs);
    timer.unref?.();
    return {
      path: lockPath,
      body,
      release: () => {
        clearInterval(timer);
        try {
          const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          if (current.nonce !== body.nonce) throw new Error('lock release nonce mismatch');
          fs.rmSync(lockPath, { force: true });
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      },
    };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let current = null;
    try { current = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { current = null; }
    const heartbeat = Date.parse(current?.heartbeatAt ?? current?.at ?? '');
    const stale = !Number.isFinite(heartbeat) || now - heartbeat > 30 * 60 * 1000;
    if (stale) {
      fs.rmSync(lockPath, { force: true });
      return acquireLock(root, { pid, now, heartbeatMs });
    }
    throw new Error('fullseed lock held');
  }
}

export function vectorBytes(vectors) {
  return Buffer.from(Float32Array.from(vectors.flat()).buffer);
}

function writeVersion(dir, { summaries, vectors, startOffset = 0 }) {
  fs.mkdirSync(dir, { recursive: true });
  const summariesText = summaries.map((s) => JSON.stringify(s)).join('\n') + (summaries.length ? '\n' : '');
  const vec = vectorBytes(vectors);
  fs.writeFileSync(path.join(dir, 'summaries.jsonl'), summariesText, 'utf8');
  fs.writeFileSync(path.join(dir, 'vectors.f32'), vec);
  const records = [];
  let offset = 0;
  for (let i = 0; i < vectors.length; i += 1) {
    records.push({ chunkId: summaries[i].chunkId, summarySha256: summaries[i].summarySha256, offset: startOffset + offset, dimensions: vectors[i].length });
    offset += vectors[i].length * 4;
  }
  fs.writeFileSync(path.join(dir, 'vector-records.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''), 'utf8');
  return { summariesText, vec, records };
}

export function verifyArtifact(dir, { summaries, vectors, startOffset = 0 } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const sm = fs.readFileSync(path.join(dir, 'summaries.jsonl'), 'utf8');
  const vb = fs.readFileSync(path.join(dir, 'vectors.f32'));
  const vr = fs.readFileSync(path.join(dir, 'vector-records.jsonl'), 'utf8');
  if (summaries !== undefined && summaries !== manifest.summaries) throw new Error('summary count mismatch');
  if (vectors !== undefined && vectors !== manifest.vectors) throw new Error('vector count mismatch');
  if (sha(sm) !== manifest.summariesSha256) throw new Error('summaries hash mismatch');
  if (sha(vb) !== manifest.vectorsSha256) throw new Error('vectors hash mismatch');
  if (sha(vr) !== manifest.vectorRecordsSha256) throw new Error('records hash mismatch');
  const records = vr.split(/\r?\n/).filter(Boolean).map(JSON.parse);
  for (const rec of records) {
    if (rec.offset + rec.dimensions * 4 > vb.length) throw new Error('vector offset out of range');
  }
  return manifest;
}

export function writeBase(root, { baseId, summaries, vectors, identity, checkpoint, snapshotBoundary }) {
  const dir = path.join(root, 'bases', baseId);
  if (fs.existsSync(dir)) throw new Error('immutable base already exists');
  const { summariesText, vec, records } = writeVersion(dir, { summaries, vectors });
  const manifest = {
    version: 1, baseId, checkpoint, snapshotBoundary, identity,
    summaries: summaries.length, vectors: vectors.length,
    summariesSha256: sha(summariesText), vectorsSha256: sha(vec),
    vectorRecordsSha256: sha(records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '')),
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  verifyArtifact(dir, { summaries: manifest.summaries, vectors: manifest.vectors });
  return { dir, manifest };
}

export function writeDelta(root, { baseId, deltaId, summaries, vectors, fromCheckpoint, toCheckpoint, identity, startOffset = 0 }) {
  const dir = path.join(root, 'bases', baseId, 'deltas', deltaId);
  if (fs.existsSync(dir)) throw new Error('immutable delta already exists');
  const { summariesText, vec, records } = writeVersion(dir, { summaries, vectors, startOffset });
  const manifest = {
    version: 1, deltaId, fromCheckpoint, toCheckpoint, identity,
    summaries: summaries.length, vectors: vectors.length,
    summariesSha256: sha(summariesText), vectorsSha256: sha(vec),
    vectorRecordsSha256: sha(records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '')),
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  verifyArtifact(dir);
  return { dir, manifest };
}

export function activate(root, { baseId, deltaIds = [], identity, checkpoint, snapshotBoundary, pending = 0 }) {
  if (pending !== 0) throw new Error(`activation refused: ${pending} pending chunks`);
  verifyArtifact(path.join(root, 'bases', baseId), {});
  for (const deltaId of deltaIds) verifyArtifact(path.join(root, 'bases', baseId, 'deltas', deltaId), {});
  const active = { version: 1, baseId, deltaIds, identity, checkpoint, snapshotBoundary, activatedAt: nowIso(), pending: 0 };
  const temp = path.join(root, '.active.tmp');
  fs.writeFileSync(temp, `${JSON.stringify(active, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, path.join(root, 'active.json'));
  return active;
}

export function readActive(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'active.json'), 'utf8'));
}

/** Merge base plus all deltas; each record keeps its physical offset. */
export function loadMergedIndex(root, active) {
  const versions = [path.join(root, 'bases', active.baseId), ...(active.deltaIds ?? []).map((id) => path.join(root, 'bases', active.baseId, 'deltas', id))];
  const summaries = [];
  const vectors = [];
  for (const dir of versions) {
    const sm = fs.readFileSync(path.join(dir, 'summaries.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const records = fs.readFileSync(path.join(dir, 'vector-records.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const buf = fs.readFileSync(path.join(dir, 'vectors.f32'));
    for (const summary of sm) {
      const rec = records.find((r) => r.chunkId === summary.chunkId && r.summarySha256 === summary.summarySha256);
      if (!rec) throw new Error('missing vector record');
      summaries.push(summary);
      vectors.push(Array.from(new Float32Array(buf.buffer, buf.byteOffset + rec.offset, rec.dimensions)));
    }
  }
  return { summaries, vectors };
}

export { sha };
