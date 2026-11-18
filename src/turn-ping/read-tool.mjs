import { createHash } from 'node:crypto';
import { eventText } from './source-view.mjs';
import { clipUtf8 } from './raw-read.mjs';

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

export function createReadSeqRangeTool({ sessionQuery, resolveSessionQuery, maxBytes = 4096, allowedSessionIds = null } = {}) {
  const resolve = (exec) => {
    if (typeof resolveSessionQuery === 'function') return resolveSessionQuery(exec);
    return sessionQuery;
  };
  return {
    name: 'read_seq_range',
    description: 'Read exact raw conversation text overlapping a seq range. Maximum 4096 UTF-8 bytes, char-safe head/tail clipping, no fuzzy retrieval and no automatic expansion.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fromSeq: { type: 'integer', description: 'Inclusive start seq.' },
        toSeq: { type: 'integer', description: 'Inclusive end seq.' },
      },
      required: ['fromSeq', 'toSeq'],
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value ?? '') }] },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    async execute(args = {}, exec = {}) {
      const service = resolve(exec);
      if (!service || typeof service.readSession !== 'function') throw new Error('read_seq_range: sessionQuery unavailable');
      const fromSeq = Number(args.fromSeq);
      const toSeq = Number(args.toSeq);
      if (!Number.isInteger(fromSeq) || !Number.isInteger(toSeq) || fromSeq > toSeq) throw new Error('read_seq_range: invalid range');
      const sessionId = exec?.agent?.session?.id;
      if (!sessionId) throw new Error('read_seq_range: no current session');
      if (Array.isArray(allowedSessionIds) && allowedSessionIds.length > 0 && !allowedSessionIds.map(String).includes(String(sessionId))) {
        throw new Error('read_seq_range: session not enabled for canary');
      }
      const snapshot = await service.readSession(String(sessionId));
      const events = (Array.isArray(snapshot?.events) ? snapshot.events : [])
        .filter((event) => Number(event.seq) >= fromSeq && Number(event.seq) <= toSeq)
        .sort((a, b) => Number(a.seq) - Number(b.seq));
      const selected = [];
      for (const event of events) {
        if (!['user/message', 'assistant/message', 'tool/result'].includes(event.type)) continue;
        const text = eventText(event);
        if (!text.trim()) continue;
        selected.push({ seq: Number(event.seq), type: event.type, text, recordLine: JSON.stringify(event) });
      }
      const full = selected.map((row) => `[${row.type} | seq=${row.seq}]\n${row.text}`).join('\n\n');
      const clipped = clipUtf8(full, maxBytes);
      return JSON.stringify({
        fromSeq,
        toSeq,
        seqs: selected.map((row) => row.seq),
        rawTextSha256: sha(full),
        rawRecordSha256: sha(selected.map((row) => row.recordLine).join('\n')),
        returnedSha256: sha(clipped.text),
        text: clipped.text,
        truncated: clipped.truncated,
        originalBytes: clipped.originalBytes,
        returnedBytes: clipped.bytes,
      });
    },
  };
}
