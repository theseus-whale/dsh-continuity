import { sha256 } from './config.mjs';
import { mapFoldToTurns } from './fold-map.mjs';
import { buildSourceView, eventText } from './source-view.mjs';
import { normalizeSummaryText, summaryWarnings } from '../fullseed/summary.mjs';

export function validateSummary(text, config) {
  return normalizeSummaryText(text).trim() ? [] : ['empty'];
}

export function validateSummaryWarnings(text, config, chunkText = '') {
  return summaryWarnings(normalizeSummaryText(text), chunkText);
}

/**
 * Fold-only write path. A missing/empty fold produces zero summaries and
 * zero vector writes. Provider failures are recorded, never replaced by old text.
 */
export async function writeFoldSummaries({
  sessionId,
  fold,
  turns,
  eventsBySeq,
  provider,
  summaryStore,
  vectorStore = null,
  config,
  writtenKeys = new Set(),
}) {
  if (!fold || !Array.isArray(fold.shadowedSeqs) || fold.shadowedSeqs.length === 0) {
    return { writes: 0, vectors: 0, missing: [], partialHOLD: [], outside: [], skipped: [], ledger: [] };
  }
  const mapped = mapFoldToTurns({ sessionId, fold, turns, writtenKeys });
  const ledger = [];
  if (mapped.candidates.length === 0) {
    return { writes: 0, vectors: 0, ...mapped, ledger };
  }
  let writes = 0;
  let vectors = 0;
  for (const turn of mapped.candidates) {
    const events = [];
    for (let seq = turn.seqStart; seq <= turn.seqEnd; seq += 1) {
      const event = eventsBySeq.get(seq);
      if (event) events.push(event);
    }
    const view = buildSourceView(events, config);
    if (!view.text.trim()) {
      ledger.push({ turnId: turn.turnId, status: 'empty-no-new-conversation-content', sourceViewSha256: view.sourceViewSha256 });
      continue;
    }
    let accepted = null;
    const attempts = [];
    for (let attempt = 1; attempt <= config.summary.maxAttempts; attempt += 1) {
      try {
        const response = await provider({ turn, sourceView: view.text, attempt });
        const text = normalizeSummaryText(response);
        const warnings = validateSummaryWarnings(text, config, view.text);
        const empty = !text.trim();
        attempts.push({ attempt, model: response?.model ?? null, usage: response?.usage ?? null, warnings });
        if (!empty) { accepted = { ...response, text, warnings }; break; }
      } catch (error) {
        attempts.push({ attempt, error: String(error?.message ?? error), issues: [] });
      }
    }
    if (!accepted) {
      ledger.push({ turnId: turn.turnId, status: 'missing-summary', attempts, sourceViewSha256: view.sourceViewSha256 });
      continue;
    }
    const summary = {
      sessionId,
      turnId: turn.turnId,
      seqStart: turn.seqStart,
      seqEnd: turn.seqEnd,
      rawTextSha256: turn.rawTextSha256,
      sourceViewSha256: view.sourceViewSha256,
      firstFoldSeq: turn.firstFoldSeq,
      availableCutoff: turn.availableCutoff,
      summaryText: accepted.text,
      summaryLength: accepted.text.length,
      summarySha256: sha256(accepted.text),
      warnings: accepted.warnings ?? [],
      issues: accepted.warnings ?? [],
      summaryProvider: accepted.provider ?? config.summary.model,
      summaryModel: accepted.model ?? null,
      promptVersion: config.summary.promptVersion,
      status: 'complete',
      attempts,
      usage: accepted.usage ?? null,
    };
    await summaryStore.put(turn.idempotencyKey, summary);
    writtenKeys.add(turn.idempotencyKey);
    writes += 1;
    if (vectorStore) {
      const vector = await vectorStore.append(summary);
      if (vector) vectors += 1;
    }
    ledger.push({ turnId: turn.turnId, status: 'written', summarySha256: summary.summarySha256, attempts });
  }
  return { writes, vectors, ...mapped, ledger };
}

export { eventText };
