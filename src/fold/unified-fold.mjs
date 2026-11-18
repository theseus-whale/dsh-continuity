import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../turn-ping/config.mjs';
import { buildTurnsFromEvents } from '../turn-ping/host.mjs';
import { buildSourceView, eventText } from '../turn-ping/source-view.mjs';
import { foldId, mapFoldToTurns, turnKey } from '../turn-ping/fold-map.mjs';
import { normalizeSummaryText, summaryWarnings, countConcreteNouns } from '../fullseed/summary.mjs';

const BLOCK = (turn, text, summarySha256) =>
  `[folded turn ${turn.turnId}${turn.chunkId ? ` | chunk=${turn.chunkId}` : ''} | seq=${turn.seqStart}-${turn.seqEnd} | summarySha256=${summarySha256}]\n${text}`;

function legacyAdapter(storage, config) {
  return {
    summaries: () => storage.summaries(),
    vectors: () => storage.vectors(),
    async commitBatch(records, { cutoff }) {
      for (const row of records) {
        if (row.source === 'generated') await storage.appendSummary(row.summary);
        if (row.vector) {
          await storage.appendVector({
            turnId: row.summary.turnId,
            summarySha256: row.summary.summarySha256,
            availableCutoff: row.summary.availableCutoff ?? cutoff,
            embeddingModel: config.vector.model,
            dimensions: row.vector.length,
            vector: row.vector,
            vectorIndexVersion: config.version ?? 'unified-fold-v1',
          });
        }
      }
      await storage.writeVectorMeta({ indexVersion: `unified-${config.summary.promptVersion}`, model: config.vector.model, dimensions: config.vector.dimensions });
      return { mode: 'legacy' };
    },
    appendLedger: (entry) => storage.appendLedger(entry),
  };
}

/** A partial old turn may reuse a summary only with exact raw evidence. */
function existingChunkMatchesTurn(chunk, turn, eventsBySeq) {
  if (!chunk || !turn || String(chunk.turnId ?? '') !== String(turn.turnId)) return false;
  if (typeof chunk.summaryText !== 'string' || !chunk.summaryText.trim()) return false;
  if (chunk.summarySha256 !== sha256(chunk.summaryText)) return false;
  if (chunk.sessionId && turn.sessionId && String(chunk.sessionId) !== String(turn.sessionId)) return false;
  if (Number(chunk.seqStart) === Number(turn.seqStart) && Number(chunk.seqEnd) === Number(turn.seqEnd)
    && chunk.rawTextSha256 === turn.rawTextSha256) return true;
  if (!Array.isArray(chunk.eventOffsets) || chunk.eventOffsets.length === 0 || typeof chunk.rawTextSha256 !== 'string') return false;
  const pieces = [];
  for (const offset of chunk.eventOffsets) {
    const seq = Number(offset?.seq);
    const start = Number(offset?.start);
    const end = Number(offset?.end);
    const event = eventsBySeq.get(seq);
    if (!event || seq < turn.seqStart || seq > turn.seqEnd || !Number.isInteger(start) || !Number.isInteger(end)) return false;
    const full = eventText(event);
    if (start < 0 || end <= start || end > full.length) return false;
    pieces.push(full.slice(start, end));
  }
  return sha256(pieces.join('\n\n')) === chunk.rawTextSha256;
}

/** Reuse a Host turn only with one unified summary or complete chunk coverage. */
function reusableHostTurnChunks(chunks, turn, eventsBySeq) {
  const unified = chunks.find((chunk) => !Array.isArray(chunk.eventOffsets)
    && Number(chunk.seqStart) === Number(turn.seqStart) && Number(chunk.seqEnd) === Number(turn.seqEnd)
    && existingChunkMatchesTurn(chunk, turn, eventsBySeq));
  if (unified) return [unified];
  const chunked = chunks.filter((chunk) => Array.isArray(chunk.eventOffsets));
  if (chunked.length === 0 || chunked.some((chunk) => !existingChunkMatchesTurn(chunk, turn, eventsBySeq))) return [];
  const allowed = [...eventsBySeq.values()].filter((event) => Number(event.seq) >= turn.seqStart && Number(event.seq) <= turn.seqEnd)
    .filter((event) => event.type === 'user/message'
      ? ['user', 'peer'].includes(event?.data?.message?.source?.kind ?? event?.data?.source?.kind ?? null)
      : ['assistant/message', 'tool/result'].includes(event.type))
    .filter((event) => eventText(event).trim());
  const allowedSeqs = new Set(allowed.map((event) => Number(event.seq)));
  const offsetsBySeq = new Map();
  for (const chunk of chunked) {
    for (const offset of chunk.eventOffsets) {
      const seq = Number(offset.seq);
      if (!allowedSeqs.has(seq)) return [];
      const list = offsetsBySeq.get(seq) ?? [];
      list.push(offset);
      offsetsBySeq.set(seq, list);
    }
  }
  for (const event of allowed) {
    const seq = Number(event.seq);
    const offsets = (offsetsBySeq.get(seq) ?? []).sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const offset of offsets) {
      if (offset.start !== cursor) return [];
      cursor = offset.end;
    }
    if (cursor !== eventText(event).length) return [];
  }
  return [...chunked].sort((a, b) => Number(a.chunkIndex ?? 0) - Number(b.chunkIndex ?? 0));
}

/**
 * Keep the inherited transaction, but move its end before a turn it would cut.
 * Historical residuals (turn.seqEnd <= end) need no adjustment. If no balanced
 * boundary remains, leave the original range intact so exact-summary reuse or
 * the existing partial-turn protection can decide the outcome.
 */
export function alignUnifiedFoldEnd({ session, sessionId = '', start, end, events = [], turns, isBalancedAfter = () => true }) {
  const nodes = Array.from(session?.surface?.nodes ?? []);
  const startIdx = nodes.indexOf(start);
  let endIdx = nodes.indexOf(end);
  if (startIdx < 0 || endIdx < startIdx) return { start, end, adjusted: false, reason: 'invalid-range' };
  const requestedEnd = end;
  const adjustments = [];
  const eventsBySeq = new Map(events.map((event) => [Number(event.seq), event]));
  while (endIdx >= startIdx) {
    const candidateEnd = nodes[endIdx];
    const mapped = mapFoldToTurns({
      sessionId,
      fold: { from: start, to: candidateEnd, shadowedSeqs: nodes.slice(startIdx, endIdx + 1) },
      turns: turns ?? [], surfaceSeqs: nodes, eventsBySeq,
    });
    if (mapped.missing.length > 0 || mapped.outside.length > 0) return { start, end: requestedEnd, adjusted: false, reason: 'unmapped-surface' };
    const held = [...mapped.partialHOLD].reverse().find((item) => (turns ?? []).find((turn) => turn.turnId === item.turnId)?.closed === false);
    if (!held) return { start, end: candidateEnd, adjusted: candidateEnd !== requestedEnd, adjustments };
    if (adjustments.some((item) => item.turnId === held.turnId)) {
      return { start, end: requestedEnd, adjusted: false, reason: 'interleaved-open-turn', protectedTurn: held.turnId, adjustments };
    }
    const tail = (turns ?? []).find((turn) => turn.turnId === held.turnId);
    const turnStart = tail?.hostStart ?? tail?.seqStart;
    let previous = endIdx - 1;
    while (previous >= startIdx
      && (nodes[previous] >= turnStart || !isBalancedAfter(session, nodes[previous]))) previous -= 1;
    if (previous < startIdx) {
      return { start, end: requestedEnd, adjusted: false, reason: 'protected-partial-turn', protectedTurn: held.turnId, adjustments };
    }
    adjustments.push({ turnId: held.turnId, from: candidateEnd, to: nodes[previous] });
    endIdx = previous;
  }
  return { start, end: requestedEnd, adjusted: false, reason: 'no-complete-range', adjustments };
}

/**
 * Unified fold batch. The caller's existing compaction transaction owns the
 * begin/summary/replace/end sequence. This module stages each accepted turn as
 * it finishes, then commits the same records to index and context after the
 * transaction has committed. It never calls the inherited summarizer.
 */
export function createUnifiedFoldBatch({
  sessionId,
  session,
  start,
  end,
  events,
  turns,
  config,
  provider,
  embedder,
  storage,
  indexAdapter = null,
  stagingDir,
}) {
  const surface = Array.from(session?.surface?.nodes ?? []);
  const startIdx = surface.indexOf(start);
  const endIdx = surface.indexOf(end);
  if (startIdx < 0 || endIdx < startIdx) throw new Error('unified fold: invalid surface range');
  const shadowedSeqs = surface.slice(startIdx, endIdx + 1);
  const fold = { compactionId: null, from: start, to: end, cutoff: end, gistSeq: null, shadowedSeqs };
  const index = indexAdapter ?? legacyAdapter(storage, config);
  const batch = {
    sessionId, fold, stagingDir, status: 'prepared', plan: null,
    records: [], blocks: [], providerCalls: 0, generated: new Map(),
    committed: false, indexPending: false,
  };
  const stagingFile = () => stagingDir ? path.join(stagingDir, `${foldId({ from: start, to: end })}.jsonl`) : null;
  const stageRow = (row) => {
    const file = stagingFile();
    if (!file) return;
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ summary: row.summary, vector: row.vector, block: row.block ?? null })}\n`, 'utf8');
  };
  const stagedRows = () => {
    const file = stagingFile();
    if (!file) return [];
    try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; }
  };

  async function prepare() {
    const current = await index.summaries();
    const staged = stagedRows().map((row) => row.summary).filter(Boolean);
    const currentVectors = await index.vectors();
    const existingByTurn = new Map();
    for (const summary of [...current, ...staged]) {
      const turnId = summary.turnId ?? summary.chunkId;
      if (!turnId) continue;
      const list = existingByTurn.get(turnId) ?? [];
      list.push({ ...summary, chunkId: summary.chunkId ?? turnId });
      existingByTurn.set(turnId, list);
    }
    const vectorKeys = new Set(currentVectors.map((v) => `${v.chunkId ?? v.turnId}:${v.summarySha256}`));
    for (const row of stagedRows()) if (row.vector) vectorKeys.add(`${row.summary.chunkId ?? row.summary.turnId}:${row.summary.summarySha256}`);
    // Every complete turn is selected. Existing chunks are grouped and reused;
    // treating writtenKeys as one key per turn would drop a long fold's other chunks.
    const allTurns = turns ?? buildTurnsFromEvents(sessionId, events);
    const eventsBySeq = new Map(events.map((event) => [Number(event.seq), event]));
    const mapped = mapFoldToTurns({
      sessionId, fold, turns: allTurns, writtenKeys: new Set(),
      surfaceSeqs: session?.surface?.nodes ?? null, eventsBySeq,
    });
    const partialReused = [];
    const partialClosed = [];
    const unresolvedPartial = [];
    const skippedResidual = (mapped.residual ?? []).map((seq) => ({ seq, reason: 'surface-projection' }));
    const reusableFor = (turn, chunks) => turn?.hostStart === undefined
      ? chunks
      : reusableHostTurnChunks(chunks, turn, eventsBySeq);
    for (const held of mapped.partialHOLD) {
      const turn = allTurns.find((candidate) => candidate.turnId === held.turnId);
      const existingChunks = turn ? reusableFor(turn, existingByTurn.get(turn.turnId) ?? []) : [];
      const exactEvidence = turn && existingChunks.length > 0
        && existingChunks.every((chunk) => existingChunkMatchesTurn(chunk, turn, eventsBySeq));
      if (exactEvidence) partialReused.push({ turn, existingChunks });
      else if (turn?.closed === true) partialClosed.push({ turn, existingChunks: [] });
      else unresolvedPartial.push(held);
    }
    if (unresolvedPartial.length > 0) {
      const sample = unresolvedPartial.slice(0, 8).map((x) => x.turnId).join(',');
      throw new Error(`unified fold: ${unresolvedPartial.length} open partial turns cannot be folded (sample: ${sample})`);
    }
    if (mapped.missing.length > 0) throw new Error(`unified fold: shadowed seqs outside known turns: ${mapped.missing.join(',')}`);
    if (mapped.outside.length > 0) throw new Error('unified fold: shadowed seqs outside fold');
    const selected = [
      ...mapped.candidates.map((turn) => ({ turn, existingChunks: reusableFor(turn, existingByTurn.get(turn.turnId) ?? []) })),
      ...partialReused,
      ...partialClosed,
    ].sort((a, b) => a.turn.seqStart - b.turn.seqStart);
    batch.plan = { selected, skipped: skippedResidual, vectorKeys, partialHOLD: unresolvedPartial, partialReused: partialReused.length, partialClosed: partialClosed.length, skippedResidual: skippedResidual.length, missing: mapped.missing, outside: mapped.outside };
    return batch.plan;
  }

  async function summarizeTurn(item) {
    const { turn, existingChunks } = item;
    if (existingChunks.length > 0) {
      for (const chunk of existingChunks) {
        const block = BLOCK({ ...turn, chunkId: chunk.chunkId }, chunk.summaryText, chunk.summarySha256);
        const key = `${chunk.chunkId ?? turn.turnId}:${chunk.summarySha256}`;
        if (!batch.plan.vectorKeys.has(key)) {
          const vector = await embedder(chunk.summaryText);
          const row = { summary: chunk, vector, source: 'existing-summary-vector-backfill', block };
          batch.records.push(row); stageRow(row);
        } else {
          batch.records.push({ summary: chunk, vector: null, source: 'reused', block });
        }
        batch.blocks.push({ type: 'text', text: block });
      }
      return;
    }
    const turnEvents = events.filter((candidate) => Number(candidate.seq) >= turn.seqStart && Number(candidate.seq) <= turn.seqEnd);
    const view = buildSourceView(turnEvents, config);
    if (!view.text.trim()) throw new Error(`unified fold: empty source view for ${turn.turnId}`);
    let accepted = null;
    const attempts = [];
    for (let attempt = 1; attempt <= config.summary.maxAttempts; attempt += 1) {
      batch.providerCalls += 1;
      const response = await provider({ turn, sourceView: view.text, attempt });
      const normalized = normalizeSummaryText(response);
      const warnings = summaryWarnings(normalized, view.text);
      const empty = !normalized.trim();
      attempts.push({ attempt, warnings, usage: response?.usage ?? null, model: response?.model ?? null });
      if (!empty) { accepted = response; break; }
    }
    if (!accepted) throw new Error(`unified fold: no valid L for ${turn.turnId}`);
    const text = normalizeSummaryText(accepted);
    if (!text.trim()) throw new Error(`unified fold: empty summary for ${turn.turnId}`);
    const warnings = summaryWarnings(text, view.text);
    const concreteNouns = countConcreteNouns(text, view.text);
    const blockText = BLOCK(turn, text, sha256(text));
    const summary = {
      sessionId, turnId: turn.turnId, seqStart: turn.seqStart, seqEnd: turn.seqEnd,
      rawTextSha256: turn.rawTextSha256, sourceViewSha256: view.sourceViewSha256,
      firstFoldSeq: end, availableCutoff: Math.max(end, turn.seqEnd),
      summaryText: text, summaryLength: text.length, summarySha256: sha256(text),
      blockText, blockSha256: sha256(blockText),
      summaryProvider: accepted.provider ?? config.summary.model, summaryModel: accepted.model ?? null,
      promptVersion: config.summary.promptVersion, status: 'complete', quality: concreteNouns.length < 2 ? 'weak-nouns' : 'normal', concreteNouns, warnings, issues: warnings, attempts, usage: accepted.usage ?? null,
    };
    const vector = await embedder(text);
    const row = { summary, vector, source: 'generated', block: blockText };
    batch.records.push(row); stageRow(row);
    batch.blocks.push({ type: 'text', text: blockText });
    batch.generated.set(turn.idempotencyKey, summary);
  }

  async function summarize() {
    if (batch.status === 'committed') return { summary: batch.blocks, provider: config.summary.provider ?? 'unified-fold', model: config.summary.model, usage: null };
    if (batch.status === 'failed') throw new Error('unified fold: failed batch cannot be summarized');
    if (batch.plan === null) await prepare();
    if (batch.plan.selected.length === 0 && batch.plan.skipped.length === 0) throw new Error('unified fold: no complete turns in selected range');
    for (const item of batch.plan.selected) await summarizeTurn(item);
    batch.status = 'staged';
    return { summary: batch.blocks, provider: config.summary.provider ?? 'unified-fold', model: config.summary.model, usage: null };
  }

  async function commit(result) {
    if (batch.status === 'failed') throw new Error('unified fold: failed batch cannot commit');
    if (batch.committed) return { committed: true, duplicate: true };
    if (batch.status !== 'staged') throw new Error('unified fold: batch was not staged');
    batch.fold.compactionId = result?.compactionId ?? null;
    try {
      const committed = await index.commitBatch(batch.records, { compactionId: batch.fold.compactionId, cutoff: end });
      await (index.appendLedger ?? storage.appendLedger)({ at: new Date().toISOString(), kind: 'unified-fold-commit', foldId: batch.fold.compactionId, summaries: batch.records.length, providerCalls: batch.providerCalls, mode: committed.mode });
      batch.committed = true;
      batch.status = 'committed';
      return { committed: true, summaries: batch.records.length, mode: committed.mode };
    } catch (error) {
      batch.indexPending = true;
      batch.status = 'index-pending';
      if (stagingDir) {
        fs.mkdirSync(stagingDir, { recursive: true });
        fs.writeFileSync(path.join(stagingDir, `${foldId({ from: start, to: end })}.pending.json`), `${JSON.stringify({ at: new Date().toISOString(), compactionId: batch.fold.compactionId, cutoff: end, records: batch.records, error: String(error?.message ?? error) }, null, 2)}\n`, 'utf8');
      }
      await storage.appendLedger({ at: new Date().toISOString(), kind: 'unified-fold-index-pending', foldId: batch.fold.compactionId, error: String(error?.message ?? error) });
      return { committed: false, indexPending: true, error: String(error?.message ?? error) };
    }
  }

  async function fail(error) {
    if (batch.committed) return;
    batch.status = 'failed';
    batch.error = String(error?.message ?? error);
    if (stagingDir) {
      fs.mkdirSync(stagingDir, { recursive: true });
      fs.writeFileSync(path.join(stagingDir, `${foldId({ from: start, to: end })}.failed.json`), `${JSON.stringify({ at: new Date().toISOString(), error: batch.error, plan: batch.plan, records: batch.records }, null, 2)}\n`, 'utf8');
    }
    try { await storage.appendLedger({ at: new Date().toISOString(), kind: 'unified-fold-failed', foldId: foldId({ from: start, to: end }), error: batch.error, providerCalls: batch.providerCalls }); } catch { /* best effort */ }
  }

  return { batch, prepare, summarize, commit, fail };
}

/** Recover a durable pending index commit without calling provider. */
export async function recoverUnifiedPending({ indexAdapter, storage, stagingDir }) {
  if (!stagingDir || !fs.existsSync(stagingDir)) return { recovered: 0, failed: 0 };
  let recovered = 0; let failed = 0;
  for (const name of fs.readdirSync(stagingDir).filter((n) => n.endsWith('.pending.json'))) {
    const file = path.join(stagingDir, name);
    try {
      const pending = JSON.parse(fs.readFileSync(file, 'utf8'));
      await indexAdapter.commitBatch(pending.records, { compactionId: pending.compactionId, cutoff: pending.cutoff });
      await storage.appendLedger({ at: new Date().toISOString(), kind: 'unified-fold-recovered', foldId: pending.compactionId });
      fs.rmSync(file, { force: true }); recovered += 1;
    } catch { failed += 1; }
  }
  return { recovered, failed };
}

export function unifiedContentHash(blocks) {
  return sha256(blocks.map((block) => block.text ?? '').join('\n'));
}
