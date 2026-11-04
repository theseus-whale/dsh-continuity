import { writeChildAsset } from './assets.mjs';

const CONFIDENCE = new Set(['high', 'medium', 'low']);

function strings(value) {
  return (Array.isArray(value) ? value : [])
    .filter((item) => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

function seqs(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 0);
}

/** Normalize a PTC child result into the parent-facing handoff envelope. */
export function normalizeHandoff(input) {
  if (input === null || typeof input !== 'object') {
    throw new Error('ptc_handoff: envelope must be an object');
  }
  const childSessionId = String(input.childSessionId ?? '').trim();
  const runId = String(input.runId ?? '').trim();
  if (childSessionId.length === 0) throw new Error('ptc_handoff: childSessionId is required');
  if (runId.length === 0) throw new Error('ptc_handoff: runId is required');
  const summary = String(input.summary ?? '').trim();
  if (summary.length === 0) throw new Error('ptc_handoff: summary is required');
  const confidence = String(input.confidence ?? 'medium').toLowerCase();
  if (!CONFIDENCE.has(confidence)) throw new Error('ptc_handoff: confidence must be high, medium, or low');
  return {
    status: typeof input.status === 'string' && input.status.length > 0 ? input.status : 'ok',
    childSessionId,
    runId,
    summary,
    decisions: strings(input.decisions),
    open: strings(input.open),
    artifacts: strings(input.artifacts),
    sourceSeqs: seqs(input.sourceSeqs),
    confidence,
    createdAt: new Date().toISOString(),
  };
}

export function handoffText(envelope) {
  return [
    `[ptc-handoff child=${envelope.childSessionId} run=${envelope.runId} confidence=${envelope.confidence}]`,
    `status: ${envelope.status}`,
    `summary: ${envelope.summary}`,
    ...(envelope.decisions.length ? [`decisions: ${envelope.decisions.join(' | ')}`] : []),
    ...(envelope.open.length ? [`open: ${envelope.open.join(' | ')}`] : []),
    ...(envelope.artifacts.length ? [`artifacts: ${envelope.artifacts.join(', ')}`] : []),
    ...(envelope.sourceSeqs.length ? [`sourceSeqs: ${envelope.sourceSeqs.join(',')}`] : []),
  ].join('\n');
}

/** Persist the full envelope as a child artifact; the parent gets a pointer. */
export async function writeHandoff({ home, parentSessionId, envelope }) {
  const normalized = normalizeHandoff(envelope);
  const payload = Buffer.from(JSON.stringify(normalized, null, 2), 'utf8');
  const written = await writeChildAsset({
    home,
    parentSessionId,
    childSessionId: normalized.childSessionId,
    runId: normalized.runId,
    block: {
      type: 'file',
      name: 'handoff.json',
      mimeType: 'application/json',
      source: { data: payload.toString('base64'), media_type: 'application/json' },
    },
    seq: normalized.sourceSeqs[0] ?? 0,
  });
  return { envelope: normalized, written };
}
