import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildRawChunks, verifyChunk } from './chunks.mjs';
import { loadStaging, stagingPaths, buildIdentity } from './seed.mjs';
import { writeBase, activate } from './storage.mjs';
import { buildChunkSummary, normalizeSummaryText, summaryWarnings } from './summary.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');

export const REPAIR_PROMPT = '请为下面这段原始对话写一段便于以后检索的中文摘要。只依据原文，不补写。直接输出摘要正文；不要输出 JSON、不要重复 chunkId、不要使用代码块。约 256 字是软目标，可以超出；不要为了长度截断内容。换行、Markdown 和多句都可以接受。';
export const REPAIR_PROMPT_SHA256 = sha(REPAIR_PROMPT);
export const REPAIR_EXTRACTION_SHA256 = sha(JSON.stringify({ version: 'repair-soft-v2', softTarget: 256, hardRejectOnly: 'empty' }));

export function readMissingPlan(missingPath) {
  const plan = JSON.parse(fs.readFileSync(missingPath, 'utf8'));
  const rows = Array.isArray(plan.rows) ? plan.rows : [];
  if (rows.length === 0) throw new Error('missing plan has no rows');
  return { plan, rows };
}

export function rootCounter(root) {
  return path.join(root, 'provider-calls-root.json');
}

export function readRootCalls(root) {
  const file = rootCounter(root);
  if (!fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Number.isInteger(value?.calls)) throw new Error('invalid root provider counter');
  return value;
}

export function reserveRootCall(root, { initialCalls = 0, maxCalls = Infinity } = {}) {
  const file = rootCounter(root);
  let value = readRootCalls(root);
  if (value === null) {
    value = { calls: initialCalls, at: new Date().toISOString() };
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
  }
  if (value.calls >= maxCalls) throw new Error('root provider call cap reached');
  value = { calls: value.calls + 1, at: new Date().toISOString() };
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, 'utf8');
  fs.renameSync(temp, file);
  return value.calls;
}

export function createCallBudget(maxCalls) {
  let used = 0;
  return {
    tryReserve() { if (used >= maxCalls) return false; used += 1; return true; },
    get used() { return used; },
    get max() { return maxCalls; },
  };
}

export function normalizeL(response) {
  return normalizeSummaryText(response);
}

async function repairOne({ chunk, provider, root, initialCalls, maxCalls, callBudget = null, reserve = true }) {
  const attempts = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (callBudget && !callBudget.tryReserve()) {
      return { chunk, status: 'budget-stop', attempts, error: 'repair call budget exhausted' };
    }
    let calls;
    try {
      calls = reserve ? reserveRootCall(root, { initialCalls, maxCalls }) : (initialCalls + attempt);
    } catch (error) {
      return { chunk, status: 'budget-stop', attempts, error: String(error?.message ?? error) };
    }
    try {
      const response = await provider({ prompt: REPAIR_PROMPT, chunk: chunk.rawText, chunkId: chunk.chunkId, attempt });
      const text = normalizeL(response);
      const warnings = summaryWarnings(text, chunk.rawText);
      const empty = !text.trim();
      attempts.push({ attempt, ok: !empty, warnings, calls });
      if (!empty) {
        const summary = buildChunkSummary({ chunk, text, provider: 'deepseek-official', model: 'deepseek-flash', promptVersion: 'chunk-summary-repair-v2-soft', usage: response?.usage ?? null, issues: warnings, attempts });
        summary.promptTextSha256 = REPAIR_PROMPT_SHA256;
        summary.extractionRuleSha256 = REPAIR_EXTRACTION_SHA256;
        summary.cohort = 'repair';
        summary.warnings = warnings;
        return { chunk, summary, status: 'complete', attempts };
      }
    } catch (error) {
      attempts.push({ attempt, ok: false, error: String(error?.message ?? error), calls });
    }
  }
  return { chunk, status: 'missing', attempts };
}

export function planRepair({ rawPath, sessionId, checkpointSeq, missingPath, oldIdentity, repairIdentity, maxProviderCalls = 7802, initialCalls = 0 }) {
  const { rows } = readMissingPlan(missingPath);
  const raw = fs.readFileSync(rawPath);
  // decode delegated to caller in CLI; this function receives events? Keep pure path for CLI below.
  throw new Error('planRepair requires events; use buildRepairPlan');
}

function loadCohort(root, cohort) {
  const dir = path.join(root, 'staging', String(cohort));
  if (!fs.existsSync(dir)) return loadStaging(root, cohort);
  const read = (file) => { try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse); } catch { return []; } };
  const summaries = read(path.join(dir, 'summaries.jsonl'));
  const vectors = read(path.join(dir, 'vectors.jsonl'));
  const byChunk = new Map();
  for (const summary of summaries) {
    const vector = vectors.find((row) => row.chunkId === summary.chunkId && row.summarySha256 === summary.summarySha256);
    if (vector) byChunk.set(summary.chunkId, { summary, vector: vector.values });
  }
  return { summaries, vectors, byChunk };
}

export function buildRepairPlan({ events, sessionId, checkpointSeq, missingPath, oldIdentity, oldCohorts = null, repairIdentity, root, maxProviderCalls = 7802, initialCalls = 0 }) {
  const { rows } = readMissingPlan(missingPath);
  const { chunks } = buildRawChunks(sessionId, events, { checkpointSeq });
  const byId = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
  const missing = rows.map((row) => {
    const chunk = byId.get(row.chunkId);
    if (!chunk) throw new Error(`missing plan chunk absent from raw: ${row.chunkId}`);
    return chunk;
  });
  if (new Set(missing.map((c) => c.chunkId)).size !== missing.length) throw new Error('duplicate chunk in missing plan');
  const allChunks = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
  const cohorts = (Array.isArray(oldCohorts) && oldCohorts.length > 0 ? oldCohorts : [oldIdentity]).map(String);
  const oldAccepted = [];
  const oldVectors = [];
  const seen = new Map();
  for (const cohort of cohorts) {
    const old = loadCohort(root, cohort);
    for (const row of old.byChunk.values()) {
      if (seen.has(row.summary.chunkId)) {
        if (seen.get(row.summary.chunkId).summarySha !== row.summary.summarySha256) throw new Error(`cohort conflict for ${row.summary.chunkId}`);
        continue;
      }
      seen.set(row.summary.chunkId, { summarySha: row.summary.summarySha256 });
      oldAccepted.push(row.summary);
      oldVectors.push(row.vector);
    }
  }
  const current = readRootCalls(root);
  const currentCalls = current?.calls ?? initialCalls;
  return { rows, chunks, byId, allChunks, eventsBySeq: new Map(events.map((event) => [Number(event.seq), event])), missing, oldAccepted, oldVectors, cohorts, currentCalls, maxProviderCalls, remaining: Math.max(0, maxProviderCalls - currentCalls), repairIdentity, oldIdentity, providerCallsUsed: 0 };
}

export async function runRepair({ plan, provider, embedder, root, repairIdentity, dryRun = true, initialCalls = 0, maxProviderCalls = 7802, repairMaxCalls = Infinity, approve = false, expectedMissing = null }) {
  if (!dryRun && !approve) throw new Error('repair requires --approve');
  if (!dryRun && expectedMissing !== null && expectedMissing !== plan.missing.length) throw new Error('missing count mismatch');
  if (!dryRun && plan.remaining < plan.missing.length) throw new Error('insufficient root budget');
  const maxCalls = Math.min(repairMaxCalls, plan.missing.length * 2);
  if (dryRun) {
    return { dryRun: true, acceptedOld: plan.oldAccepted.length, cohorts: plan.cohorts, missing: plan.missing.length, expectedCalls: plan.missing.length, maxCalls, currentCalls: plan.currentCalls, remaining: plan.remaining, oldIdentity: plan.oldIdentity, repairIdentity };
  }
  const repair = loadStaging(root, repairIdentity);
  const accepted = new Map(repair.byChunk);
  const repaired = [];
  const repairBudget = createCallBudget(maxCalls);
  for (let offset = 0; offset < plan.missing.length; offset += 4) {
    const allowance = Math.max(0, maxCalls - repairBudget.used);
    if (allowance === 0) break;
    const batch = plan.missing.slice(offset, offset + Math.min(4, allowance));
    const results = await Promise.all(batch.map(async (chunk) => {
      if (accepted.has(chunk.chunkId)) return { chunk, summary: accepted.get(chunk.chunkId).summary, vector: accepted.get(chunk.chunkId).vector, status: 'reused', attempts: [] };
      const result = await repairOne({ chunk, provider, root, initialCalls, maxCalls: maxProviderCalls, callBudget: repairBudget });
      if (result.status !== 'complete') return { chunk, status: result.status, attempts: result.attempts };
      result.summary.availableCutoff = Math.max(...plan.chunks.map((item) => item.seqEnd));
      const vector = await embedder(result.summary.summaryText);
      if (!Array.isArray(vector) || vector.length !== 512 || !vector.every(Number.isFinite)) throw new Error(`invalid repair vector for ${chunk.chunkId}`);
      const p = stagingPaths(root, repairIdentity);
      fs.mkdirSync(p.dir, { recursive: true });
      fs.appendFileSync(p.summaries, `${JSON.stringify(result.summary)}\n`, 'utf8');
      fs.appendFileSync(p.vectors, `${JSON.stringify({ chunkId: chunk.chunkId, summarySha256: result.summary.summarySha256, dimensions: vector.length, values: vector })}\n`, 'utf8');
      return { chunk, summary: result.summary, vector, status: 'written', attempts: result.attempts };
    }));
    repaired.push(...results);
  }
  const complete = repaired.filter((row) => row.status === 'written' || row.status === 'reused');
  const pending = plan.missing.length - complete.length;
  const unprocessed = plan.missing.filter((chunk) => !repaired.some((row) => row.chunk.chunkId === chunk.chunkId));
  if (pending !== 0) return { dryRun: false, pending, repaired, unprocessed: unprocessed.map((chunk) => chunk.chunkId), active: null, activated: false, usedCalls: repairBudget.used, maxCalls };
  // Verify then merge; no activation in dry-run, activation only after all checks.
  const allSummaries = [...plan.oldAccepted, ...complete.map((row) => row.summary)];
  const allVectors = [...plan.oldVectors, ...complete.map((row) => row.vector)];
  verifyMerged({ plan, summaries: allSummaries, vectors: allVectors });
  const baseId = `repair-${sha(JSON.stringify({ repairIdentity, cohorts: plan.cohorts, count: allSummaries.length })).slice(0, 24)}`;
  const base = writeBase(root, { baseId, summaries: allSummaries, vectors: allVectors, identity: repairIdentity, checkpoint: Math.max(...plan.chunks.map((c) => c.seqEnd)), snapshotBoundary: null });
  const active = activate(root, { baseId, identity: repairIdentity, checkpoint: base.manifest.checkpoint, snapshotBoundary: null, pending: 0 });
  return { dryRun: false, pending: 0, repaired, base, active, activated: true, cohorts: plan.cohorts, oldIdentity: plan.oldIdentity, repairIdentity, usedCalls: repairBudget.used, maxCalls };
}

export function verifyMerged({ plan, summaries, vectors }) {
  if (summaries.length !== plan.chunks.length) throw new Error('merged summary count mismatch');
  if (vectors.length !== summaries.length) throw new Error('merged vector count mismatch');
  const seen = new Set();
  for (let i = 0; i < summaries.length; i += 1) {
    const summary = summaries[i];
    if (seen.has(summary.chunkId)) throw new Error('duplicate chunk in merged set');
    seen.add(summary.chunkId);
    const chunk = plan.allChunks.get(summary.chunkId);
    if (!chunk) throw new Error('merged summary has no raw chunk');
    if (summary.rawTextSha256 !== chunk.rawTextSha256) throw new Error('merged raw hash mismatch');
    if (summary.seqStart !== chunk.seqStart || summary.seqEnd !== chunk.seqEnd) throw new Error('merged seq mismatch');
    if (!verifyChunk(chunk, plan.eventsBySeq)) throw new Error('merged raw offsets mismatch');
    if (!Array.isArray(vectors[i]) || vectors[i].length !== 512 || !vectors[i].every(Number.isFinite)) throw new Error('invalid merged vector');
  }
  if (seen.size !== plan.chunks.length) throw new Error('merged coverage mismatch');
  return true;
}
