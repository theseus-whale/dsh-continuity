import { createHash } from 'node:crypto';
import { buildSourceView, eventText } from '../source-view.mjs';
import { validateSummary } from '../summary-writer.mjs';
import { sha256 } from '../config.mjs';
import { disclosureCount } from '../retrieval.mjs';

const summarySha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

export async function runBackfillBatch({ audit, staging, events, provider, embedder, config, batchSize = 4, indexVersion }) {
  if (!audit || !staging) throw new Error('backfill runner: audit/staging required');
  const done = new Set((await staging.summaries()).map((row) => row.turnId));
  const candidates = audit.eligible.filter((turn) => !done.has(turn.turnId)).slice(0, Math.max(1, batchSize));
  const result = { processed: 0, written: 0, missing: 0, errors: [], lastSeq: (await staging.cursor()).lastSeq ?? 0 };
  for (const turn of candidates) {
    const eventsInTurn = (events ?? []).filter((event) => Number(event.seq) >= turn.seqStart && Number(event.seq) <= turn.seqEnd);
    const view = buildSourceView(eventsInTurn, config);
    if (!view.text.trim()) {
      result.missing += 1;
      await staging.appendLedger({ at: new Date().toISOString(), kind: 'backfill-missing', turnId: turn.turnId, reason: 'empty-source-view' });
      result.lastSeq = turn.seqEnd;
      result.processed += 1;
      continue;
    }
    let accepted = null;
    const attempts = [];
    for (let attempt = 1; attempt <= config.summary.maxAttempts; attempt += 1) {
      try {
        const response = await provider({ turn, sourceView: view.text, attempt });
        const issues = validateSummary(response?.text, config);
        attempts.push({ attempt, model: response?.model ?? null, usage: response?.usage ?? null, issues });
        if (issues.length === 0) { accepted = response; break; }
      } catch (error) {
        attempts.push({ attempt, error: String(error?.message ?? error), issues: [] });
      }
    }
    if (!accepted) {
      result.missing += 1;
      await staging.appendLedger({ at: new Date().toISOString(), kind: 'backfill-missing', turnId: turn.turnId, attempts });
      result.lastSeq = turn.seqEnd;
      result.processed += 1;
      continue;
    }
    const vector = await embedder(accepted.text, 'document');
    if (!Array.isArray(vector) || vector.length !== config.vector.dimensions) {
      result.missing += 1;
      await staging.appendLedger({ at: new Date().toISOString(), kind: 'backfill-missing', turnId: turn.turnId, reason: 'embedding-dimension' });
      result.lastSeq = turn.seqEnd;
      result.processed += 1;
      continue;
    }
    const summary = {
      sessionId: audit.sessionId,
      turnId: turn.turnId,
      seqStart: turn.seqStart,
      seqEnd: turn.seqEnd,
      rawTextSha256: turn.rawTextSha256,
      sourceViewSha256: view.sourceViewSha256,
      firstFoldSeq: null,
      availableCutoff: audit.checkpoint,
      writeOrigin: 'legacy-backfill',
      backfillId: staging.paths.root.split(/[\\/]/).at(-1),
      summaryText: accepted.text,
      summaryLength: accepted.text.length,
      summarySha256: summarySha(accepted.text),
      provider: accepted.provider ?? config.summary.model,
      model: accepted.model ?? null,
      promptVersion: config.summary.promptVersion,
      status: 'complete',
      attempts,
      usage: accepted.usage ?? null,
    };
    await staging.appendSummary(summary);
    await staging.appendVector({
      turnId: turn.turnId,
      summarySha256: summary.summarySha256,
      availableCutoff: summary.availableCutoff,
      embeddingModel: config.vector.model,
      dimensions: config.vector.dimensions,
      vector,
      vectorIndexVersion: indexVersion ?? config.version,
    });
    result.written += 1;
    result.processed += 1;
    result.lastSeq = turn.seqEnd;
  }
  await staging.saveCursor({ lastSeq: result.lastSeq, updatedAt: new Date().toISOString() });
  return result;
}

export async function runBackfill({ audit, staging, events, provider, embedder, config, indexVersion, batchSize = 4, maxBatches = 1000 }) {
  let batches = 0;
  let aggregate = { processed: 0, written: 0, missing: 0 };
  while (batches < maxBatches) {
    const before = await staging.summaries();
    const result = await runBackfillBatch({ audit, staging, events, provider, embedder, config, indexVersion, batchSize });
    batches += 1;
    aggregate.processed += result.processed;
    aggregate.written += result.written;
    aggregate.missing += result.missing;
    if (result.processed === 0) break;
    const after = await staging.summaries();
    if (after.length === before.length && result.written === 0) break;
  }
  return { ...aggregate, batches, pending: audit.eligible.length - (await staging.summaries()).length };
}
