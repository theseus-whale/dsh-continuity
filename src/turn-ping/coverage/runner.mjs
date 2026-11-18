import { createHash } from 'node:crypto';
import { buildSourceView } from '../source-view.mjs';
import { validateSummary } from '../summary-writer.mjs';

const sha = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

export async function runCoveragePlan({ plan, staging, events, provider, embedder, config, indexVersion }) {
  const result = { summaryWritten: 0, vectorWritten: 0, missing: 0, skipped: 0, errors: [] };
  let lastSeq = 0;
  const persistCursor = async () => {
    if (typeof staging?.saveCursor === 'function') {
      await staging.saveCursor({ lastSeq, updatedAt: new Date().toISOString(), pending: plan.pending ?? null });
    }
  };
  for (const item of plan.items) {
    if (item.kind === 'covered' || item.kind === 'hold') { result.skipped += 1; continue; }
    lastSeq = Math.max(lastSeq, Number(item.turn.seqEnd) || 0);
    if (item.kind === 'vector') {
      const vector = await embedder(item.summary.summaryText, 'document');
      if (!Array.isArray(vector) || vector.length !== config.vector.dimensions) {
        result.missing += 1;
        await staging.appendLedger({ at: new Date().toISOString(), kind: 'coverage-vector-failed', turnId: item.turn.turnId, reason: 'embedding-dimension' });
        await persistCursor();
        continue;
      }
      await staging.appendVector({
        turnId: item.turn.turnId,
        summarySha256: item.summary.summarySha256,
        availableCutoff: item.summary.availableCutoff,
        embeddingModel: config.vector.model,
        dimensions: config.vector.dimensions,
        vector,
        vectorIndexVersion: indexVersion,
      });
      result.vectorWritten += 1;
      lastSeq = Math.max(lastSeq, Number(item.turn.seqEnd) || 0);
      await persistCursor();
      continue;
    }
    if (item.kind === 'summary') {
      const eventsInTurn = (events ?? []).filter((event) => Number(event.seq) >= item.turn.seqStart && Number(event.seq) <= item.turn.seqEnd);
      const view = buildSourceView(eventsInTurn, config);
      if (!view.text.trim()) {
        result.missing += 1;
        await staging.appendLedger({ at: new Date().toISOString(), kind: 'coverage-summary-missing', turnId: item.turn.turnId, reason: 'empty-source-view' });
        await persistCursor();
        continue;
      }
      let accepted = null;
      const attempts = [];
      for (let attempt = 1; attempt <= config.summary.maxAttempts; attempt += 1) {
        try {
          const response = await provider({ turn: item.turn, sourceView: view.text, attempt });
          const issues = validateSummary(response?.text, config);
          attempts.push({ attempt, model: response?.model ?? null, usage: response?.usage ?? null, issues });
          if (issues.length === 0) { accepted = response; break; }
        } catch (error) {
          attempts.push({ attempt, error: String(error?.message ?? error), issues: [] });
        }
      }
      if (!accepted) {
        result.missing += 1;
        await staging.appendLedger({ at: new Date().toISOString(), kind: 'coverage-summary-missing', turnId: item.turn.turnId, attempts });
        await persistCursor();
        continue;
      }
      const vector = await embedder(accepted.text, 'document');
      if (!Array.isArray(vector) || vector.length !== config.vector.dimensions) {
        result.missing += 1;
        await staging.appendLedger({ at: new Date().toISOString(), kind: 'coverage-vector-missing', turnId: item.turn.turnId, attempts });
        await persistCursor();
        continue;
      }
      const summary = {
        sessionId: item.turn.sessionId,
        turnId: item.turn.turnId,
        seqStart: item.turn.seqStart,
        seqEnd: item.turn.seqEnd,
        rawTextSha256: item.turn.rawTextSha256,
        sourceViewSha256: view.sourceViewSha256,
        firstFoldSeq: item.turn.firstFoldSeq ?? null,
        availableCutoff: item.turn.availableCutoff,
        writeOrigin: item.turn.writeOrigin ?? 'incremental',
        backfillId: staging.coverageId ?? null,
        summaryText: accepted.text,
        summaryLength: accepted.text.length,
        summarySha256: sha(accepted.text),
        provider: accepted.provider ?? config.summary.model,
        model: accepted.model ?? null,
        promptVersion: config.summary.promptVersion,
        status: 'complete',
        attempts,
        usage: accepted.usage ?? null,
      };
      await staging.appendSummary(summary);
      await staging.appendVector({
        turnId: item.turn.turnId,
        summarySha256: summary.summarySha256,
        availableCutoff: summary.availableCutoff,
        embeddingModel: config.vector.model,
        dimensions: config.vector.dimensions,
        vector,
        vectorIndexVersion: indexVersion,
      });
      result.summaryWritten += 1;
      result.vectorWritten += 1;
      await persistCursor();
    }
  }
  await persistCursor();
  return result;
}
