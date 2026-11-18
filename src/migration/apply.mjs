import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildRawChunks, verifyChunk } from '../fullseed/chunks.mjs';
import { loadStaging, runSeed } from '../fullseed/seed.mjs';
import { writeBase, activate, verifyArtifact } from '../fullseed/storage.mjs';
import { loadActiveIndex } from '../fullseed/cache.mjs';
import { reserveRootCall, readRootCalls } from '../fullseed/repair.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');

export function readPlan(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const plan = JSON.parse(raw);
  if (plan.schemaVersion !== 1 || plan.contractVersion !== 'continuity-migration-plan-v1') throw new Error('apply: unsupported plan schema/contract');
  const { contentSha256, ...body } = plan;
  if (!contentSha256 || sha(JSON.stringify(body)) !== contentSha256) throw new Error('apply: plan content hash mismatch');
  return { plan, file, fileSha256: sha(raw) };
}

export async function validatePlan({ plan, dshHome }) {
  if (!plan.sessionId || !plan.raw?.path) throw new Error('apply: plan missing session/raw');
  if (!fs.existsSync(plan.raw.path)) throw new Error('apply: raw path missing');
  if (sha(fs.readFileSync(plan.raw.path)) !== plan.raw.sha256) throw new Error('apply: raw hash changed');
  if (!Number.isInteger(plan.checkpoint) || plan.checkpoint <= 0) throw new Error('apply: finite checkpoint required');
  const { decodeRaw } = await import('./raw.mjs');
  const events = decodeRaw(plan.raw.path);
  const header = events.find((event) => event?.type === 'session');
  if (!header || String(header.id) !== String(plan.sessionId)) throw new Error('apply: raw session mismatch');
  if (Number(events.at(-1)?.seq) + 1 !== plan.checkpoint) throw new Error('apply: raw checkpoint changed');
  const chunks = buildRawChunks(String(plan.sessionId), events, { checkpointSeq: plan.checkpoint }).chunks;
  const digest = sha(chunks.map((chunk) => chunk.chunkId).sort().join('\n'));
  if (chunks.length !== plan.chunkSet?.count || digest !== plan.chunkSet.sha256 || chunks[0]?.chunkId !== plan.chunkSet.first || chunks.at(-1)?.chunkId !== plan.chunkSet.last) throw new Error('apply: chunkSet changed');
  const bySeq = new Map(events.map((event) => [Number(event.seq), event]));
  if (!chunks.every((chunk) => verifyChunk(chunk, bySeq))) throw new Error('apply: raw chunk verification failed');
  const byId = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
  const missing = plan.missingItems ?? [];
  const reusable = plan.reusableItems ?? [];
  if (!Array.isArray(missing) || !Array.isArray(reusable)) throw new Error('apply: items missing');
  const seen = new Set();
  for (const item of [...missing, ...reusable]) {
    const chunk = byId.get(item.chunkId);
    if (!chunk) throw new Error(`apply: plan item not in raw ${item.chunkId}`);
    if (chunk.rawTextSha256 !== item.rawTextSha256 || chunk.seqStart !== item.seqStart || chunk.seqEnd !== item.seqEnd) throw new Error(`apply: plan item raw mismatch ${item.chunkId}`);
    if (seen.has(item.chunkId)) throw new Error(`apply: duplicate plan item ${item.chunkId}`);
    seen.add(item.chunkId);
  }
  for (const item of reusable) {
    if (item.cohort !== 'fullseed' || item.source !== 'fullseed-active') throw new Error(`apply: unknown frozen reuse source ${item.chunkId}`);
    if (!item.summarySha256 || !Number.isInteger(item.availableCutoff) || item.availableCutoff <= 0 || item.availableCutoff > plan.checkpoint) throw new Error(`apply: invalid frozen reuse metadata ${item.chunkId}`);
  }
  if (seen.size !== chunks.length) throw new Error('apply: plan items do not cover all chunks');
  const root = plan.storageRoot;
  if (!root) throw new Error('apply: storageRoot missing');
  const counter = readRootCalls(root);
  if (counter && counter.calls > plan.budget.maxProviderCalls) throw new Error('apply: root provider counter exceeds plan cap');
  return { chunks, missingItems: missing, reusableItems: reusable, root, events };
}

export async function applyMigration({ planFile, plan, provider, embedder, resume = false }) {
  const checked = await validatePlan({ plan, dshHome: null });
  const missing = new Set(checked.missingItems.map((item) => item.chunkId));
  const chunks = checked.chunks.filter((chunk) => missing.has(chunk.chunkId));
  const root = checked.root;
  const counter = readRootCalls(root);
  const initialCalls = counter?.calls ?? plan.budget.rootInitialCalls ?? 0;
  const cap = plan.budget.maxProviderCalls;
  const wrapped = async (args) => {
    reserveRootCall(root, { initialCalls, maxCalls: cap });
    return provider(args);
  };
  const result = await runSeed({
    chunks,
    root,
    provider: wrapped,
    embedder,
    identity: plan.identity,
    checkpoint: plan.checkpoint,
    snapshotBoundary: plan.checkpoint,
    maxProviderCalls: plan.missing * 2,
    maxAttempts: 1,
    deferBase: true,
  });
  if (result.pending !== 0) throw new Error(`apply: pending ${result.pending}; old active preserved`);
  const staged = loadStaging(root, plan.identity);
  const existing = checked.reusableItems.length > 0 ? loadActiveIndex(root) : null;
  const reuseById = new Map();
  if (existing) {
    for (let i = 0; i < existing.merged.summaries.length; i += 1) {
      const summary = existing.merged.summaries[i];
      const vector = existing.merged.vectors[i];
      reuseById.set(summary.chunkId, { summary, vector });
    }
  }
  const summaries = [];
  const vectors = [];
  for (const chunk of checked.chunks) {
    const item = checked.reusableItems.find((row) => row.chunkId === chunk.chunkId);
    if (item) {
      const found = reuseById.get(chunk.chunkId);
      if (!found) throw new Error(`apply: frozen reusable source missing ${chunk.chunkId}`);
      if (found.summary.summarySha256 !== item.summarySha256) throw new Error(`apply: frozen reusable summary changed ${chunk.chunkId}`);
      summaries.push(found.summary);
      vectors.push(found.vector);
    } else {
      const found = staged.byChunk.get(chunk.chunkId);
      if (!found) throw new Error(`apply: staging missing ${chunk.chunkId}`);
      summaries.push(found.summary);
      vectors.push(found.vector);
    }
  }
  if (summaries.length !== checked.chunks.length || vectors.length !== checked.chunks.length) throw new Error('apply: staging incomplete; old active preserved');
  for (let i = 0; i < checked.chunks.length; i += 1) {
    const chunk = checked.chunks[i];
    const summary = summaries[i];
    const vector = vectors[i];
    if (summary.rawTextSha256 !== chunk.rawTextSha256 || summary.seqStart !== chunk.seqStart || summary.seqEnd !== chunk.seqEnd) throw new Error(`apply: pre-activation raw mismatch ${chunk.chunkId}`);
    if (!Number.isInteger(summary.availableCutoff) || summary.availableCutoff <= 0 || summary.availableCutoff > plan.checkpoint) throw new Error(`apply: pre-activation cutoff mismatch ${chunk.chunkId}`);
    if (typeof summary.summaryText !== 'string' || summary.summaryText.trim().length === 0) throw new Error(`apply: pre-activation empty summary ${chunk.chunkId}`);
    if (!Array.isArray(vector) || vector.length !== 512 || !vector.every(Number.isFinite)) throw new Error(`apply: pre-activation vector mismatch ${chunk.chunkId}`);
  }
  const chunkSetDigest = sha(checked.chunks.map((chunk) => chunk.chunkId).sort().join('\n'));
  const baseId = `base-${sha(JSON.stringify({ identity: plan.identity, chunkSetDigest, checkpoint: plan.checkpoint })).slice(0, 24)}`;
  const baseDir = path.join(root, 'bases', baseId);
  if (fs.existsSync(baseDir)) verifyArtifact(baseDir, { summaries: summaries.length, vectors: vectors.length });
  else writeBase(root, { baseId, summaries, vectors, identity: plan.identity, checkpoint: plan.checkpoint, snapshotBoundary: plan.checkpoint });
  const active = activate(root, { baseId, identity: plan.identity, checkpoint: plan.checkpoint, snapshotBoundary: plan.checkpoint, pending: 0 });
  return { baseId, active, calls: result.calls.length, pending: result.pending, rootInitialCalls: initialCalls, fileSha256: sha(fs.readFileSync(planFile)), planContentSha256: plan.contentSha256 };
}
