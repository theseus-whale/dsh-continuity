/** Exact UTF-16 offset/UTF-8 byte continuation read for a stored raw chunk. */
export function createReadRawChunkTool({ chunks }) {
  const byId = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
  return {
    name: 'read_raw_chunk',
    description: 'Read exact bytes from one stored raw chunk by chunkId and byte offset; returns nextByteOffset.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chunkId: { type: 'string' },
        byteOffset: { type: 'integer', minimum: 0 },
        maxBytes: { type: 'integer', minimum: 1, maximum: 4096 },
      },
      required: ['chunkId'],
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value ?? '') }] },
    async execute({ chunkId, byteOffset = 0, maxBytes = 4096 } = {}) {
      const chunk = byId.get(String(chunkId));
      if (!chunk) throw new Error(`read_raw_chunk: unknown chunkId ${chunkId}`);
      if (!Number.isInteger(byteOffset) || byteOffset < 0) throw new Error('read_raw_chunk: invalid byteOffset');
      if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 4096) throw new Error('read_raw_chunk: invalid maxBytes');
      const raw = Buffer.from(chunk.rawText, 'utf8');
      if (byteOffset > raw.length) throw new Error('read_raw_chunk: byteOffset past end');
      let end = Math.min(raw.length, byteOffset + maxBytes);
      while (end > byteOffset && (raw[end] & 0xc0) === 0x80) end -= 1;
      const slice = raw.subarray(byteOffset, end);
      return JSON.stringify({
        chunkId: chunk.chunkId,
        byteOffset,
        nextByteOffset: end,
        final: end >= raw.length,
        bytes: slice.length,
        text: slice.toString('utf8'),
        sha256: (await import('node:crypto')).createHash('sha256').update(slice).digest('hex'),
      });
    },
  };
}

export function installReadRawChunk(ctx, tool) {
  ctx.effect(() => ctx.tools.register(tool), { label: 'read_raw_chunk' });
  return tool;
}
