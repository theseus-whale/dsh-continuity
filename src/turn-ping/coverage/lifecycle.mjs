import { createCoverageJournal } from './journal.mjs';
import { createCoverageStaging } from './staging.mjs';

import { runCoveragePlan } from './runner.mjs';
import { ensureCoverage } from './index.mjs';
import { createTurnPingStorage } from '../storage.mjs';
import { verifyCoverage } from './verify.mjs';

export function hostSnapshot({ sessionId, checkpoint, activeTailStartSeq, scope = null }) {
  if (!Number.isInteger(checkpoint)) throw new Error('hostSnapshot: checkpoint required');
  if (!Number.isInteger(activeTailStartSeq)) throw new Error('hostSnapshot: activeTailStartSeq required');
  return { sessionId, checkpoint, activeTailStartSeq, scope };
}

/**
 * Called only on session open/enable. Cold sessions are never enumerated here.
 * Legacy sessions get an initial plan; already-audited sessions only get an
 * incremental plan for the current checkpoint.
 */
export async function openSessionCoverage({ home, sessionId, events, turns, checkpoint, activeTailStartSeq, foldedSeqs, unprovableTurnIds = [], indexVersion = null, formalSummaries = [], formalVectors = [], stagedSummaries = [], stagedVectors = [] }) {
  const journal = createCoverageJournal({ home, sessionId });
  const manifest = await journal.manifest();
  const active = createTurnPingStorage({ home, sessionId });
  const currentFormal = formalSummaries.length > 0 ? formalSummaries : await active.summaries();
  const currentVectors = formalVectors.length > 0 ? formalVectors : await active.vectors();
  const priorPlan = await journal.plan();
  let currentStaged = stagedSummaries;
  let currentStagedVectors = stagedVectors;
  if (currentStaged.length === 0 && priorPlan?.staging?.coverageId) {
    const priorStage = createCoverageStaging({ home, sessionId, coverageId: priorPlan.staging.coverageId, checkpoint: priorPlan.checkpoint });
    currentStaged = await priorStage.summaries();
    currentStagedVectors = await priorStage.vectors();
  }
  const ensured = await ensureCoverage({
    home, sessionId, events, turns, checkpoint, activeTailStartSeq, foldedSeqs, unprovableTurnIds, indexVersion,
    formalSummaries: currentFormal, formalVectors: currentVectors, stagedSummaries: currentStaged, stagedVectors: currentStagedVectors,
  });
  return { ...ensured, previousStatus: manifest?.status ?? 'legacy-audit-required', opened: true };
}

/**
 * Startup resume: reads persisted manifests/plans only for sessions the host
 * already reports as open; it never scans cold session directories.
 */
export async function resumeStartupSessions({ home, sessions, eventsBySession = {}, config, provider, embedder }) {
  const results = [];
  for (const sessionId of sessions) {
    const journal = createCoverageJournal({ home, sessionId });
    const manifest = await journal.manifest();
    const plan = await journal.plan();
    if (!manifest || !plan || plan.pending === 0) {
      results.push({ sessionId, status: manifest?.status ?? 'legacy-audit-required', providerCalls: 0, summaryWrites: 0, vectorWrites: 0, rawScan: 0 });
      continue;
    }
    const sessionEvents = eventsBySession[sessionId];
    if (!Array.isArray(sessionEvents) || sessionEvents.length === 0) {
      const failed = { ...manifest, status: 'failed', pendingJobs: plan.pending, processedFoldWatermark: null, lastResume: new Date().toISOString(), lastError: 'raw-snapshot-missing' };
      await journal.writeManifest(failed);
      await journal.writePlan({ ...plan, resumedAt: new Date().toISOString(), pending: plan.pending, lastError: 'raw-snapshot-missing' });
      results.push({ sessionId, status: 'failed', providerCalls: 0, summaryWrites: 0, vectorWrites: 0, rawScan: 0, reason: 'raw-snapshot-missing' });
      continue;
    }
    const staging = createCoverageStaging({ home, sessionId, coverageId: plan.staging?.coverageId ?? `resume-${plan.checkpoint}`, checkpoint: plan.checkpoint });
    const run = await runCoveragePlan({ plan, staging, events: sessionEvents, provider, embedder, config, indexVersion: plan.indexVersion });
    const summaries = await staging.summaries();
    const vectors = await staging.vectors();
    const storage = createTurnPingStorage({ home, sessionId });
    let activeSummaries = await storage.summaries();
    let activeVectors = await storage.vectors();
    let activeTurns = new Set(activeSummaries.map((row) => row.turnId));
    let activeVectorTurns = new Set(activeVectors.map((row) => row.turnId));
    const eligibleTurns = [...new Map(plan.items.filter((item) => ['summary', 'vector'].includes(item.kind)).map((item) => [item.turn.turnId, item.turn])).values()];
    const plannedTurns = eligibleTurns.map((turn) => turn.turnId);
    let activeComplete = plannedTurns.every((turnId) => activeTurns.has(turnId) && activeVectorTurns.has(turnId));
    let activation = null;
    let activationError = null;
    if (config.autoActivate === true && run.missing === 0 && (manifest.HOLD ?? 0) === 0 && !activeComplete) {
      const summaryByTurn = new Map(summaries.map((row) => [row.turnId, row]));
      const rawBound = eligibleTurns.every((turn) => summaryByTurn.get(turn.turnId)?.rawTextSha256 === turn.rawTextSha256);
      const verification = await verifyCoverage({
        audit: { sessionId, checkpoint: plan.checkpoint, eligible: eligibleTurns, hold: [] },
        plan: { ...plan, pending: 0 },
        staging,
        activeTailStartSeq: plan.activeTailStartSeq,
      });
      if (!verification.ok || !rawBound) {
        activationError = { verification, rawBound };
      } else {
        try {
          const watermark = { ok: true, pending: 0, eligible: eligibleTurns.length, covered: summaries.length, errors: [] };
          activation = await staging.activate({ mode: 'onfold-formal', watermark });
          activeSummaries = await storage.summaries();
          activeVectors = await storage.vectors();
          activeTurns = new Set(activeSummaries.map((row) => row.turnId));
          activeVectorTurns = new Set(activeVectors.map((row) => row.turnId));
          activeComplete = plannedTurns.every((turnId) => activeTurns.has(turnId) && activeVectorTurns.has(turnId));
        } catch (error) {
          activationError = String(error?.message ?? error);
        }
      }
    }
    const status = activeComplete && run.missing === 0
      ? ((manifest.HOLD ?? 0) > 0 ? 'degraded' : 'ready')
      : (run.missing > 0 || activationError ? 'degraded' : 'catching-up');
    const pending = status === 'ready' ? 0 : Math.max(1, run.missing, plan.pending);
    const next = {
      ...manifest,
      status,
      pendingJobs: pending,
      processedFoldWatermark: status === 'ready' ? plan.checkpoint : null,
      activationPending: status !== 'ready',
      activeIndexVersion: status === 'ready' ? plan.indexVersion : (manifest.activeIndexVersion ?? null),
      activation: activation ? { versionId: activation.versionId, mode: activation.mode } : null,
      activationError,
      summaryCount: activeSummaries.length,
      vectorCount: activeVectors.length,
      retryableMissing: status === 'ready' ? 0 : (run.missing > 0 ? 0 : pending),
      terminalMissing: run.missing,
      lastResume: new Date().toISOString(),
      lastRun: { summaryWritten: run.summaryWritten, vectorWritten: run.vectorWritten, missing: run.missing, stagedSummaries: summaries.length, stagedVectors: vectors.length, activeSummaries: activeSummaries.length, activeVectors: activeVectors.length },
    };
    await journal.writeManifest(next);
    await journal.writePlan({ ...plan, pending, resumedAt: new Date().toISOString(), status, activationPending: !activeComplete });
    results.push({ sessionId, status, providerCalls: run.summaryWritten, summaryWrites: run.summaryWritten, vectorWrites: run.vectorWritten, rawScan: sessionEvents.length, activeSummaries: activeSummaries.length, activeVectors: activeVectors.length });
  }
  return results;
}
