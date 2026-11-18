import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadActiveIndex } from './cache.mjs';
import { continuityHome } from '../folds-store.mjs';
import { eventText } from './chunks.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');

function textForChunk(eventsBySeq, summary) {
  if (Array.isArray(summary.eventOffsets)) {
    const pieces = summary.eventOffsets.map((off) => {
      const event = eventsBySeq.get(Number(off.seq));
      if (!event) throw new Error(`read_raw_chunk: missing raw seq ${off.seq}`);
      const full = eventText(event);
      if (off.start < 0 || off.end > full.length || off.start >= off.end) throw new Error(`read_raw_chunk: invalid offset ${off.seq}:${off.start}-${off.end}`);
      return full.slice(off.start, off.end);
    });
    return pieces.join('\n\n');
  }
  // Unified-fold summaries identify a complete Host turn rather than a
  // fullseed event-offset chunk. Reconstruct exact raw event text, then verify
  // the same trimmed/newline identity used by buildTurnsFromEvents.
  const pieces = [...eventsBySeq.values()]
    .filter((event) => Number(event.seq) >= Number(summary.seqStart) && Number(event.seq) <= Number(summary.seqEnd))
    .sort((a, b) => Number(a.seq) - Number(b.seq))
    .filter((event) => event.type === 'user/message'
      ? ['user', 'peer'].includes(event?.data?.message?.source?.kind ?? event?.data?.source?.kind ?? null)
      : ['assistant/message', 'tool/result'].includes(event.type))
    .map(eventText)
    .filter((text) => text.trim());
  const identity = pieces.map((text) => text.trim()).join('\n');
  if (typeof summary.rawTextSha256 !== 'string' || sha(identity) !== summary.rawTextSha256) {
    throw new Error(`read_raw_chunk: raw turn hash mismatch for ${summary.chunkId ?? summary.turnId}`);
  }
  return pieces.join('\n\n');
}

export function createCanonicalReadRawChunkTool({ resolveSessionQuery, resolveRoot, allowedSessionIds = null }) {
  return {
    name: 'read_raw_chunk',
    description: 'Read exact bytes from one active raw chunk by chunkId and byte offset; returns nextByteOffset.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        chunkId: { type: 'string' },
        byteOffset: { type: 'integer', minimum: 0 },
        maxBytes: { type: 'integer', minimum: 1, maximum: 4096 },
      },
      required: ['chunkId'],
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value ?? '') }] },
    async execute({ chunkId, byteOffset = 0, maxBytes = 4096 } = {}, exec) {
      if (!Number.isInteger(byteOffset) || byteOffset < 0) throw new Error('read_raw_chunk: invalid byteOffset');
      if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 4096) throw new Error('read_raw_chunk: invalid maxBytes');
      const sessionId = exec?.agent?.session?.id;
      if (!sessionId) throw new Error('read_raw_chunk: no current session');
      if (allowedSessionIds && !allowedSessionIds.has(String(sessionId))) throw new Error('read_raw_chunk: session not allowed');
      const service = resolveSessionQuery(exec);
      if (!service || typeof service.readSession !== 'function') throw new Error('read_raw_chunk: sessionQuery unavailable');
      const root = resolveRoot({ sessionId, exec });
      const cached = loadActiveIndex(root);
      if (!cached) throw new Error('read_raw_chunk: no active fullseed version');
      const summary = cached.merged.summaries.find((row) => row.chunkId === String(chunkId));
      if (!summary) throw new Error(`read_raw_chunk: unknown chunkId ${chunkId}`);
      const session = await service.readSession(String(sessionId));
      const eventsBySeq = new Map((session?.events ?? []).map((event) => [Number(event.seq), event]));
      const raw = Buffer.from(textForChunk(eventsBySeq, summary), 'utf8');
      if (byteOffset > raw.length) throw new Error('read_raw_chunk: byteOffset past end');
      if (byteOffset < raw.length && (raw[byteOffset] & 0xc0) === 0x80) throw new Error('read_raw_chunk: byteOffset not at UTF-8 character boundary');
      let end = Math.min(raw.length, byteOffset + maxBytes);
      while (end > byteOffset && (raw[end] & 0xc0) === 0x80) end -= 1;
      const slice = raw.subarray(byteOffset, end);
      return JSON.stringify({
        chunkId: summary.chunkId, turnId: summary.turnId, seqStart: summary.seqStart, seqEnd: summary.seqEnd,
        byteOffset, nextByteOffset: end, final: end >= raw.length, bytes: slice.length,
        text: slice.toString('utf8'), sha256: sha(slice),
      });
    },
  };
}

export function installCanonicalReadRawChunkTool(ctx, { home, continuityHome: continuityHomeOverride, allowedSessionIds = null } = {}) {
  if (!ctx || typeof ctx.effect !== 'function' || !ctx.tools || typeof ctx.tools.register !== 'function') {
    throw new Error('read_raw_chunk install: injected tools context required');
  }
  const pick = (owner) => (typeof owner?.get === 'function' ? owner.get('sessionQuery') : owner?.sessionQuery);
  const resolveSessionQuery = (exec) => pick(exec?.agent?.ctx) ?? pick(ctx);
  const rootHome = continuityHomeOverride ?? home ?? (typeof ctx.get === 'function' ? ctx.get('continuityHome') : undefined) ?? continuityHome();
  const resolveRoot = ({ sessionId }) => path.join(rootHome, 'sessions', String(sessionId), 'turn-ping', 'fullseed');
  const registered = createCanonicalReadRawChunkTool({ resolveSessionQuery, resolveRoot, allowedSessionIds });
  ctx.effect(() => ctx.tools.register(registered));
  return { registered, requires: ['tools'], resolver: 'exec.agent.ctx.get(sessionQuery) -> root' };
}
