import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { acquireLock, writeBase, writeDelta, activate, verifyArtifact } from './storage.mjs';
import { summarizeChunk, weakNounsRate } from './summary.mjs';

const sha = (v) => createHash('sha256').update(v).digest('hex');

export function buildIdentity({ embedder = 'BAAI/bge-small-zh-v1.5', revision = 'local', dimensions = 512, normalize = 'cls-l2', promptTextSha256, extractionRuleSha256, cutoffPolicy = 'activation-or-turn-end-v1', chunking = 'per-turn-utf16-16000' } = {}) {
  return sha(JSON.stringify({ embedder, revision, dimensions, normalize, summaryContract: 'ChunkSummary-L-v2', promptTextSha256, extractionRuleSha256, cutoffPolicy, chunking, crossTurn: false }));
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function appendJsonl(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
}

export function stagingPaths(root, identity = 'unversioned') {
  const dir = path.join(root, 'staging', sha(String(identity)).slice(0, 16));
  return {
    dir,
    summaries: path.join(dir, 'summaries.jsonl'),
    vectors: path.join(dir, 'vectors.jsonl'),
    attempts: path.join(dir, 'attempts.jsonl'),
    cursor: path.join(dir, 'cursor.json'),
  };
}

export function loadStaging(root, identity = 'unversioned') {
  const p = stagingPaths(root, identity);
  const summaries = readJsonl(p.summaries);
  const vectors = readJsonl(p.vectors);
  const byChunk = new Map();
  for (const summary of summaries) {
    const vector = vectors.find((row) => row.chunkId === summary.chunkId && row.summarySha256 === summary.summarySha256);
    if (vector) byChunk.set(summary.chunkId, { summary, vector: vector.values });
  }
  return { summaries, vectors, byChunk, attempts: readJsonl(p.attempts) };
}

export function planSeed({ chunks, acceptedKeys = new Set() } = {}) {
  const pending = chunks.filter((chunk) => !acceptedKeys.has(chunk.chunkId));
  return { total: chunks.length, accepted: chunks.length - pending.length, pending: pending.length, chunks: pending };
}

export function dryRun({ chunks, acceptedKeys = new Set(), maxAttempts = 2, vectorDimensions = 512 } = {}) {
  const plan = planSeed({ chunks, acceptedKeys });
  return {
    totalChunks: chunks.length,
    acceptedChunks: plan.accepted,
    pendingChunks: plan.pending,
    providerCallsSuccess: plan.pending,
    providerCallsMax: plan.pending * maxAttempts,
    embeddingCalls: plan.pending,
    vectorBytes: plan.pending * vectorDimensions * 4,
    summaryBytesEstimate: plan.pending * 242,
    rawBytes: chunks.reduce((n, c) => n + (c.bytes ?? 0), 0),
  };
}

export async function runSeed({
  chunks, root, provider, embedder, maxAttempts = 2, identity, checkpoint, snapshotBoundary,
  concurrency = 4, callProvider = null, log = () => {}, deferBase = false, maxProviderCalls = Infinity, shouldStop = null,
}) {
  fs.mkdirSync(root, { recursive: true });
  const lock = acquireLock(root);
  const p = stagingPaths(root, identity);
  try {
    const staged = loadStaging(root, identity);
    const calls = [];
    const counterPath = path.join(p.dir, 'provider-calls.json');
    let providerCalls = 0;
    if (fs.existsSync(counterPath)) {
      const persisted = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
      if (!Number.isInteger(persisted?.calls) || persisted.calls < 0) throw new Error('invalid persisted provider call count');
      providerCalls = persisted.calls;
    }
    const baseProvider = callProvider ?? provider;
    const limitedProvider = async (args) => {
      if (providerCalls >= Number(maxProviderCalls)) throw new Error('provider call cap reached');
      providerCalls += 1;
      const temp = `${counterPath}.tmp`;
      fs.mkdirSync(path.dirname(counterPath), { recursive: true });
      fs.writeFileSync(temp, `${JSON.stringify({ calls: providerCalls, at: new Date().toISOString() })}\n`, 'utf8');
      fs.renameSync(temp, counterPath);
      return baseProvider(args);
    };
    let pending = chunks.filter((chunk) => !staged.byChunk.has(chunk.chunkId));
    for (let offset = 0; offset < pending.length; offset += concurrency) {
      if (shouldStop?.()) throw new Error('fullseed cancelled');
      const batch = pending.slice(offset, offset + concurrency);
      const results = await Promise.all(batch.map(async (chunk) => {
        if (shouldStop?.()) throw new Error('fullseed cancelled');
        const attemptBase = { chunkId: chunk.chunkId, turnId: chunk.turnId, at: new Date().toISOString(), providerAttempts: 0 };
        appendJsonl(p.attempts, { ...attemptBase, status: 'reserved' });
        const summary = await summarizeChunk({
          chunk,
          callProvider: limitedProvider,
          maxAttempts,
          onAttempt: (row) => {
            appendJsonl(p.attempts, { chunkId: chunk.chunkId, ...row });
            calls.push({ chunkId: chunk.chunkId, ...row });
          },
        });
        if (summary.status !== 'complete') {
          appendJsonl(p.attempts, { chunkId: chunk.chunkId, status: 'missing', attempts: summary.attempts });
          return { chunk, summary: null, vector: null };
        }
        summary.availableCutoff = checkpoint;
        summary.snapshotBoundary = snapshotBoundary;
        const vector = await embedder(summary.summaryText);
        if (!Array.isArray(vector) || vector.length !== 512 || !vector.every(Number.isFinite)) throw new Error(`invalid vector for ${chunk.chunkId}`);
        appendJsonl(p.summaries, summary);
        appendJsonl(p.vectors, { chunkId: chunk.chunkId, summarySha256: summary.summarySha256, dimensions: vector.length, values: vector });
        log({ chunkId: chunk.chunkId, status: 'written' });
        return { chunk, summary, vector };
      }));
      results.sort((a, b) => a.chunk.chunkIndex - b.chunk.chunkIndex || a.chunk.turnId.localeCompare(b.chunk.turnId));
      fs.writeFileSync(p.cursor, `${JSON.stringify({ checkpoint, completedChunks: staged.byChunk.size + results.filter((r) => r.summary).length, at: new Date().toISOString() })}\n`, 'utf8');
    }
    const final = loadStaging(root, identity);
    const accepted = chunks.filter((chunk) => final.byChunk.has(chunk.chunkId));
    const summaries = accepted.map((chunk) => final.byChunk.get(chunk.chunkId).summary);
    const vectors = accepted.map((chunk) => final.byChunk.get(chunk.chunkId).vector);
    const pendingCount = chunks.length - accepted.length;
    const chunkSetDigest = sha([...chunks.map((c) => c.chunkId)].sort().join('\n'));
    const baseId = `base-${sha(JSON.stringify({ identity, chunkSetDigest, checkpoint })).slice(0, 24)}`;
    let base = null;
    let active = null;
    if (pendingCount === 0 && !deferBase) {
      const existingBase = path.join(root, 'bases', baseId);
      if (fs.existsSync(existingBase)) {
        const manifest = JSON.parse(fs.readFileSync(path.join(existingBase, 'manifest.json'), 'utf8'));
        verifyArtifact(existingBase, { summaries: manifest.summaries, vectors: manifest.vectors });
        if (manifest.identity !== identity || manifest.checkpoint !== checkpoint || manifest.summaries !== chunks.length) throw new Error('existing base identity/content mismatch');
        base = { dir: existingBase, manifest };
      } else {
        base = writeBase(root, { baseId, summaries, vectors, identity, checkpoint, snapshotBoundary });
      }
      active = activate(root, { baseId, identity, checkpoint, snapshotBoundary, pending: 0 });
    }
    return { base, active, summaries, vectors, calls, pending: pendingCount, weakNounsRate: weakNounsRate(summaries), staging: final };
  } finally {
    lock.release();
  }
}

export function appendIncrement(root, { active, deltaId, summaries, vectors, fromCheckpoint, toCheckpoint, identity }) {
  if (!active) throw new Error('appendIncrement: no active base');
  const delta = writeDelta(root, { baseId: active.baseId, deltaId, summaries, vectors, fromCheckpoint, toCheckpoint, identity });
  const next = activate(root, { baseId: active.baseId, deltaIds: [...(active.deltaIds ?? []), deltaId], identity, checkpoint: toCheckpoint, snapshotBoundary: active.snapshotBoundary, pending: 0 });
  return { delta, active: next };
}
