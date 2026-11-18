import { auditCoverage } from './audit.mjs';
import { planCoverage } from './planner.mjs';
import { createCoverageJournal } from './journal.mjs';

export async function ensureCoverage({ sessionId, home, events = [], turns = null, checkpoint, activeTailStartSeq, foldedSeqs = null, unprovableTurnIds = [], indexVersion = null, formalSummaries = [], formalVectors = [], stagedSummaries = [], stagedVectors = [] }) {
  const audit = auditCoverage({ sessionId, events, turns, checkpoint, activeTailStartSeq, foldedSeqs, unprovableTurnIds });
  const plan = planCoverage({ audit, formalSummaries, formalVectors, stagedSummaries, stagedVectors, indexVersion, sessionId });
  const journal = createCoverageJournal({ home, sessionId });
  const status = plan.ready ? (audit.hold.length > 0 ? 'degraded' : 'ready') : 'catching-up';
  const coverageId = `initial-${checkpoint}-${plan.pending}`;
  await journal.writePlan({
    kind: 'coverage-plan-v1',
    sessionId,
    checkpoint,
    activeTailStartSeq,
    requiredIndexVersion: indexVersion,
    indexVersion,
    staging: { coverageId, checkpoint },
    items: plan.items.filter((item) => ['summary', 'vector'].includes(item.kind)),
    pending: plan.pending,
    createdAt: new Date().toISOString(),
  });
  await journal.writeManifest({
    sessionId,
    activeIndexVersion: null,
    requiredIndexVersion: indexVersion,
    hostFoldWatermark: checkpoint,
    processedFoldWatermark: plan.ready ? checkpoint : null,
    pendingJobs: plan.pending,
    summaryCount: formalSummaries.length + stagedSummaries.length,
    vectorCount: formalVectors.length + stagedVectors.length,
    retryableMissing: 0,
    terminalMissing: audit.missing.length,
    HOLD: audit.hold.length,
    activeBackfillId: coverageId,
    lastAudit: new Date().toISOString(),
    status,
  });
  return { audit, plan, journal, status };
}

export async function resumeCoverageJobs({ home, sessionId }) {
  const journal = createCoverageJournal({ home, sessionId });
  const manifest = await journal.manifest();
  const jobs = await journal.jobs();
  const plan = await journal.plan();
  const pendingJobs = jobs.filter((job) => job.status !== 'done');
  const pendingPlan = manifest?.status === 'catching-up' && plan?.pending > 0 ? plan.items : [];
  return {
    manifest,
    plan,
    pending: [...pendingJobs, ...pendingPlan],
    started: manifest?.status === 'catching-up',
  };
}

export async function onFoldCoverage({ home, sessionId, fold }) {
  const journal = createCoverageJournal({ home, sessionId });
  const inserted = await journal.appendFold({ kind: 'fold', ...fold });
  if (!inserted) return { queued: false, duplicate: true };
  await journal.appendJob({ at: new Date().toISOString(), kind: 'fold', status: 'pending', fold, foldId: fold.foldId ?? fold.compactionId ?? null, foldKey: fold.foldId ?? fold.compactionId ?? JSON.stringify(fold) });
  return { queued: true };
}

export async function getCoverageStatus({ home, sessionId }) {
  const journal = createCoverageJournal({ home, sessionId });
  const manifest = await journal.manifest();
  const jobs = await journal.jobs();
  const plan = await journal.plan();
  const foldPending = jobs.filter((job) => job.status !== 'done').length;
  const planPending = manifest?.status === 'catching-up' ? (plan?.pending ?? 0) : 0;
  return { manifest, plan, foldPending, planPending, pending: Math.max(foldPending, planPending) };
}
