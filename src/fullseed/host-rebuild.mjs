import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildRawChunks } from './chunks.mjs';
import { buildIdentity, loadStaging, runSeed } from './seed.mjs';
import { SUMMARY_PROMPT, PROMPT_TEXT_SHA256, EXTRACTION_RULE_SHA256 } from './summary.mjs';
import { acquireLock, activate, verifyArtifact } from './storage.mjs';
import { loadActiveIndex } from './cache.mjs';

const activeJobs = new Map();
const ACTIVE_STATES = new Set(['queued', 'running', 'cancelling']);
const now = () => new Date().toISOString();

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}
function persist(job) {
  const { promise, cancelRequested, ...publicFields } = job;
  atomicJson(path.join(job.workRoot, 'job.json'), { ...publicFields, cancelRequested: Boolean(cancelRequested) });
}
function publicState(job) {
  if (!job) return { status: 'none' };
  return {
    jobId: job.jobId, sessionId: job.sessionId, status: job.status,
    engine: 'host-ctx.llm', provider: job.providerName, model: job.model,
    checkpoint: job.checkpoint, latestCheckpoint: job.latestCheckpoint ?? null,
    totalChunks: job.totalChunks, completedChunks: job.completedChunks ?? 0,
    createdAt: job.createdAt, updatedAt: job.updatedAt, completedAt: job.completedAt ?? null,
    liveBaseId: job.liveBaseId ?? null, error: job.error ?? null,
  };
}
function readJob(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function latestJob(root, sessionId) {
  const dir = path.join(root, 'host-rebuild-jobs');
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => readJob(path.join(dir, entry.name, 'job.json')))
    .filter(job => job?.sessionId === sessionId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? null;
}
function allEvents(snapshot) {
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const lastSeq = Number(events.at(-1)?.seq);
  if (!Number.isInteger(lastSeq)) throw new Error('memory_rebuild: no valid history checkpoint');
  return { events, checkpoint: lastSeq + 1 };
}
function chunksFor(sessionId, events, checkpoint) {
  const chunks = buildRawChunks(sessionId, events, { checkpointSeq: checkpoint }).chunks;
  if (chunks.length === 0) throw new Error('memory_rebuild: no eligible raw turns');
  return chunks;
}

export function isHostRebuildActive(sessionId) {
  for (const job of activeJobs.values()) {
    if (job.sessionId === sessionId && ACTIVE_STATES.has(job.status)) return true;
  }
  return false;
}

export function createHostRebuildService({
  home, sessionQuery, provider, embedder, allowedSessionIds = null, concurrency = 2,
  providerName = 'deepseek-official', model = 'deepseek-flash',
}) {
  if (typeof sessionQuery?.readSession !== 'function') throw new Error('memory_rebuild: Host sessionQuery required');
  if (typeof provider !== 'function' || typeof embedder !== 'function') throw new Error('memory_rebuild: Host provider/embedder required');
  const rootFor = sessionId => path.join(home, 'sessions', sessionId, 'turn-ping', 'fullseed');

  async function execute(job, initialChunks) {
    job.status = job.cancelRequested ? 'cancelling' : 'running';
    job.updatedAt = now(); persist(job);
    const common = {
      root: job.workRoot,
      provider: args => provider({ ...args, sessionId: job.sessionId }),
      embedder, identity: job.identity,
      maxAttempts: 2, concurrency, shouldStop: () => job.cancelRequested === true,
    };
    const logProgress = () => {
      job.completedChunks = Math.min(job.totalChunks, (job.completedChunks ?? 0) + 1);
      if (job.completedChunks % 10 === 0) { job.updatedAt = now(); persist(job); }
    };
    const first = await runSeed({
      ...common, chunks: initialChunks, checkpoint: job.checkpoint, snapshotBoundary: job.checkpoint,
      maxProviderCalls: initialChunks.length * 2, log: logProgress,
    });
    if (first.pending !== 0) throw new Error(`memory_rebuild: ${first.pending} initial chunks remain`);
    job.completedChunks = first.staging.byChunk.size;

    const latest = allEvents(await sessionQuery.readSession(job.sessionId));
    const latestChunks = chunksFor(job.sessionId, latest.events, latest.checkpoint);
    job.latestCheckpoint = latest.checkpoint;
    job.totalChunks = latestChunks.length;
    const complete = await runSeed({
      ...common, chunks: latestChunks, checkpoint: latest.checkpoint, snapshotBoundary: latest.checkpoint,
      maxProviderCalls: latestChunks.length * 2, log: logProgress,
    });
    if (complete.pending !== 0) throw new Error(`memory_rebuild: ${complete.pending} catch-up chunks remain`);
    job.completedChunks = latestChunks.length;

    const shadowActive = JSON.parse(fs.readFileSync(path.join(job.workRoot, 'active.json'), 'utf8'));
    const liveRoot = rootFor(job.sessionId);
    const lock = acquireLock(liveRoot);
    try {
      const source = path.join(job.workRoot, 'bases', shadowActive.baseId);
      const target = path.join(liveRoot, 'bases', shadowActive.baseId);
      if (fs.existsSync(target)) verifyArtifact(target, {});
      else {
        const temp = `${target}.${process.pid}.tmp`;
        fs.rmSync(temp, { recursive: true, force: true });
        fs.cpSync(source, temp, { recursive: true });
        verifyArtifact(temp, {});
        fs.renameSync(temp, target);
      }
      activate(liveRoot, {
        baseId: shadowActive.baseId, identity: shadowActive.identity,
        checkpoint: shadowActive.checkpoint, snapshotBoundary: shadowActive.snapshotBoundary, pending: 0,
      });
    } finally { lock.release(); }
    const verified = loadActiveIndex(liveRoot);
    if (verified?.merged?.summaries?.length !== latestChunks.length || verified?.merged?.vectors?.length !== latestChunks.length) {
      throw new Error('memory_rebuild: live activation coverage mismatch');
    }
    job.liveBaseId = shadowActive.baseId;
    job.status = 'complete'; job.completedAt = now(); job.updatedAt = job.completedAt; persist(job);
  }

  function launch(job, chunks) {
    activeJobs.set(job.jobId, job);
    persist(job);
    job.promise = execute(job, chunks).catch(error => {
      job.status = job.cancelRequested ? 'cancelled' : 'failed';
      job.error = String(error?.message ?? error); job.updatedAt = now(); persist(job);
    });
    return publicState(job);
  }

  return {
    async probe(sessionId) {
      sessionId = String(sessionId);
      if (allowedSessionIds && !allowedSessionIds.has(sessionId)) return { status: 'not-authorized', sessionId };
      const current = allEvents(await sessionQuery.readSession(sessionId));
      const first = chunksFor(sessionId, current.events, current.checkpoint)[0];
      try {
        const response = await provider({
          prompt: SUMMARY_PROMPT, chunk: first.rawText, chunkId: first.chunkId, sessionId,
        });
        const summaryText = String(response?.text ?? '').trim();
        const formatErrors = [];
        if (/<\/?(?:path|type|content)>/i.test(summaryText)) formatErrors.push('tool-output-tag');
        if (/\b(?:Wait|Let me|Hmm)\b/i.test(summaryText)) formatErrors.push('reasoning-marker');
        if (/[\r\n]/.test(summaryText)) formatErrors.push('multiline');
        if (/^\s{0,3}#{1,6}\s|```|^\s*[-*+]\s/m.test(summaryText)) formatErrors.push('markdown-structure');
        const warnings = summaryText.length > 256 ? [`soft-too-long:${summaryText.length}`] : [];
        return {
          status: !summaryText || formatErrors.length > 0 ? 'failed' : 'complete',
          sessionId, engine: 'host-ctx.llm', provider: providerName, model,
          chunkId: first.chunkId, summaryText, writes: 0,
          error: !summaryText ? 'empty-summary' : formatErrors.length > 0 ? 'invalid-summary-format' : undefined,
          formatErrors, warnings, streamStats: response?.streamStats ?? null,
        };
      } catch (error) {
        const cause = error?.cause;
        return {
          status: 'failed', sessionId, engine: 'host-ctx.llm', provider: providerName, model,
          chunkId: first.chunkId, writes: 0,
          error: String(error?.message ?? error), code: error?.code ?? cause?.code ?? null,
          cause: cause ? {
            message: String(cause.message ?? cause), code: cause.code ?? null, status: cause.status ?? null,
            body: typeof cause.body === 'string' ? cause.body.slice(0, 500) : null,
          } : null,
        };
      }
    },
    async start(sessionId, { resume = false, jobId = null } = {}) {
      sessionId = String(sessionId);
      if (allowedSessionIds && !allowedSessionIds.has(sessionId)) return { status: 'not-authorized', sessionId };
      for (const job of activeJobs.values()) {
        if (job.sessionId === sessionId && ACTIVE_STATES.has(job.status)) return publicState(job);
      }
      const root = rootFor(sessionId);
      if (resume) {
        const saved = jobId
          ? readJob(path.join(root, 'host-rebuild-jobs', String(jobId), 'job.json'))
          : latestJob(root, sessionId);
        if (!saved) return { status: 'none', sessionId };
        const snapshot = allEvents(await sessionQuery.readSession(sessionId));
        const initial = chunksFor(sessionId, snapshot.events.filter(event => Number(event.seq) < saved.checkpoint), saved.checkpoint);
        const job = { ...saved, workRoot: path.join(root, 'host-rebuild-jobs', saved.jobId), cancelRequested: false, error: null };
        return launch(job, initial);
      }
      const current = allEvents(await sessionQuery.readSession(sessionId));
      const chunks = chunksFor(sessionId, current.events, current.checkpoint);
      const identity = buildIdentity({ promptTextSha256: PROMPT_TEXT_SHA256, extractionRuleSha256: EXTRACTION_RULE_SHA256 });
      const newJobId = `host-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const job = {
        jobId: newJobId, sessionId, status: 'queued', engine: 'host-ctx.llm', providerName, model,
        checkpoint: current.checkpoint, identity, totalChunks: chunks.length, completedChunks: 0,
        createdAt: now(), updatedAt: now(), workRoot: path.join(root, 'host-rebuild-jobs', newJobId), cancelRequested: false,
      };
      return launch(job, chunks);
    },
    async status(sessionId, jobId = null) {
      sessionId = String(sessionId);
      const root = rootFor(sessionId);
      const candidate = jobId ? activeJobs.get(jobId) : [...activeJobs.values()].find(job => job.sessionId === sessionId && ACTIVE_STATES.has(job.status));
      const memory = candidate?.sessionId === sessionId ? candidate : null;
      const saved = memory ?? (jobId ? readJob(path.join(root, 'host-rebuild-jobs', jobId, 'job.json')) : latestJob(root, sessionId));
      if (!saved || saved.sessionId !== sessionId) return { status: 'none', sessionId };
      if (!memory && ACTIVE_STATES.has(saved.status)) {
        saved.status = 'interrupted'; saved.updatedAt = now();
        atomicJson(path.join(root, 'host-rebuild-jobs', saved.jobId, 'job.json'), saved);
      }
      return publicState(saved);
    },
    async cancel(sessionId, jobId = null) {
      sessionId = String(sessionId);
      const candidate = jobId ? activeJobs.get(jobId) : [...activeJobs.values()].find(item => item.sessionId === sessionId && ACTIVE_STATES.has(item.status));
      const job = candidate?.sessionId === sessionId ? candidate : null;
      if (!job) return { status: 'not-running', sessionId };
      job.cancelRequested = true; job.status = 'cancelling'; job.updatedAt = now(); persist(job);
      return publicState(job);
    },
    async wait(jobId) {
      const job = activeJobs.get(jobId);
      if (job?.promise) await job.promise;
      return publicState(job);
    },
  };
}
