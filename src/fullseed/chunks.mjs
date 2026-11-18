import { createHash } from 'node:crypto';
import { groupTurnEvents } from '../turn-ping/turn-groups.mjs';

export const FULLSEED_CHUNK_LIMIT = 16000;
export const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

export function eventText(event) {
  const data = event?.data ?? {};
  const content = data.message?.content ?? data.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => typeof b?.text === 'string').map((b) => b.text).join('\n');
  return typeof data.text === 'string' ? data.text : '';
}

/** Per-turn lossless chunks. Chunks never cross a turn; chunkIndex is local. */
export function buildRawChunks(sessionId, events, { checkpointSeq = Infinity, maxChars = FULLSEED_CHUNK_LIMIT } = {}) {
  const ordered = [...events].filter((e) => Number(e.seq) < checkpointSeq).sort((a, b) => Number(a.seq) - Number(b.seq));
  const groups = groupTurnEvents(ordered);
  const chunks = [];
  let turnCount = 0;
  for (const group of groups) {
    const start = group.start;
    const allowed = group.allowed;
    const blocks = [];
    for (const event of allowed) {
      const text = eventText(event);
      if (!text.trim()) continue;
      if (text.length > maxChars) {
        for (let offset = 0; offset < text.length; offset += maxChars) {
          const part = text.slice(offset, offset + maxChars);
          blocks.push({ seq: Number(event.seq), text: part, offsetStart: offset, offsetEnd: offset + part.length, event });
        }
      } else {
        blocks.push({ seq: Number(event.seq), text, offsetStart: 0, offsetEnd: text.length, event });
      }
    }
    if (blocks.length === 0) continue;
    turnCount += 1;
    const turnId = `turn-${String(start).padStart(6, '0')}`;
    let pending = [];
    let chars = 0;
    let chunkIndex = 0;
    const emit = () => {
      if (pending.length === 0) return;
      const rawText = pending.map((b) => b.text).join('\n\n');
      const rawRecord = pending.map((b) => JSON.stringify(b.event)).join('\n');
      const rawTextSha256 = sha256(rawText);
      chunks.push({
        sessionId,
        turnId,
        chunkId: sha256(`${sessionId}|${turnId}|${chunkIndex}|${rawTextSha256}`),
        chunkIndex,
        seqStart: pending[0].seq,
        seqEnd: pending.at(-1).seq,
        eventOffsets: pending.map((b) => ({ seq: b.seq, start: b.offsetStart, end: b.offsetEnd })),
        rawText,
        rawTextSha256,
        rawRecordSha256: sha256(rawRecord),
        checkpointSeq,
        chars: rawText.length,
        bytes: Buffer.byteLength(rawText, 'utf8'),
      });
      chunkIndex += 1;
      pending = [];
      chars = 0;
    };
    for (const block of blocks) {
      const added = pending.length ? 2 : 0;
      if (pending.length && chars + block.text.length + added > maxChars) emit();
      if (pending.length) chars += 2;
      pending.push(block);
      chars += block.text.length;
    }
    emit();
  }
  return { chunks, turns: turnCount, checkpointSeq };
}

export function verifyChunk(chunk, eventsBySeq) {
  const pieces = chunk.eventOffsets.map((off) => {
    const event = eventsBySeq.get(Number(off.seq)) ?? eventsBySeq.get(String(off.seq));
    if (!event) throw new Error(`missing source seq ${off.seq}`);
    const full = eventText(event);
    if (off.start < 0 || off.end > full.length || off.start >= off.end) throw new Error(`invalid offset ${off.seq}:${off.start}-${off.end}`);
    return full.slice(off.start, off.end);
  });
  const text = pieces.join('\n\n');
  return text === chunk.rawText && sha256(text) === chunk.rawTextSha256;
}

/** Prefix insertion before a turn must not change that turn's chunkId. */
export function chunkIdentity(chunk) {
  return sha256(`${chunk.sessionId}|${chunk.turnId}|${chunk.chunkIndex}|${chunk.rawTextSha256}`);
}
