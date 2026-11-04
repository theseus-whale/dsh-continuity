import fs from 'node:fs';
import path from 'node:path';
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
    ...(envelope.unresolvedArtifacts?.length
      ? [`unresolved artifacts: ${envelope.unresolvedArtifacts.map((item) => item.source).join(', ')}`]
      : []),
    ...(envelope.sourceSeqs.length ? [`sourceSeqs: ${envelope.sourceSeqs.join(',')}`] : []),
  ].join('\n');
}

/** Persist the full envelope as a child artifact; the parent gets a pointer. */
export async function writeHandoff({ home, parentSessionId, envelope }) {
  const normalized = normalizeHandoff(envelope);
  const artifacts = [];
  const artifactSources = [];
  const unresolvedArtifacts = [];
  const baseSeq = normalized.sourceSeqs[0] ?? 0;
  for (let index = 0; index < normalized.artifacts.length; index += 1) {
    const source = normalized.artifacts[index];
    try {
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
        unresolvedArtifacts.push({ source, reason: 'not-a-file' });
        continue;
      }
      const artifactSeq = baseSeq + index + 1;
      const written = await writeChildAsset({
        home,
        parentSessionId,
        childSessionId: normalized.childSessionId,
        runId: normalized.runId,
        block: {
          type: 'file',
          path: source,
          name: path.basename(source),
        },
        seq: artifactSeq,
      });
      if (!written.ok) {
        unresolvedArtifacts.push({ source, reason: written.reason ?? 'no-payload' });
        continue;
      }
      artifacts.push(written.row.path);
      artifactSources.push({
        source,
        path: written.row.path,
        seq: artifactSeq,
        mime: written.row.mime,
        sha256: written.row.sha256,
        bytes: written.row.bytes,
      });
    } catch (error) {
      unresolvedArtifacts.push({ source, reason: String(error?.message ?? error) });
    }
  }
  const result = {
    ...normalized,
    artifacts,
    artifactSources,
    artifactsResolved: unresolvedArtifacts.length === 0,
    unresolvedArtifacts,
  };
  const payload = Buffer.from(JSON.stringify(result, null, 2), 'utf8');
  const written = await writeChildAsset({
    home,
    parentSessionId,
    childSessionId: result.childSessionId,
    runId: result.runId,
    block: {
      type: 'file',
      name: 'handoff.json',
      mimeType: 'application/json',
      source: { data: payload.toString('base64'), media_type: 'application/json' },
    },
    seq: result.sourceSeqs[0] ?? 0,
  });
  return { envelope: result, written };
}
