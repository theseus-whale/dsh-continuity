export function clipUtf8(text, maxBytes) {
  const buffer = Buffer.from(text ?? '', 'utf8');
  if (buffer.length <= maxBytes) return { text: text ?? '', truncated: false, originalBytes: buffer.length, bytes: buffer.length };
  const marker = `\n…[truncated ${buffer.length - maxBytes} bytes]…\n`;
  const available = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
  const headTarget = Math.floor(available * 0.6);
  const tailTarget = available - headTarget;
  let headEnd = Math.min(headTarget, buffer.length);
  while (headEnd > 0 && (buffer[headEnd] & 0xc0) === 0x80) headEnd -= 1;
  let tailStart = Math.max(0, buffer.length - tailTarget);
  while (tailStart < buffer.length && (buffer[tailStart] & 0xc0) === 0x80) tailStart += 1;
  const out = buffer.subarray(0, headEnd).toString('utf8') + marker + buffer.subarray(tailStart).toString('utf8');
  return { text: out, truncated: true, originalBytes: buffer.length, bytes: Buffer.byteLength(out, 'utf8') };
}

export function readSeqRange(turns, fromSeq, toSeq, maxBytes) {
  if (!Number.isInteger(fromSeq) || !Number.isInteger(toSeq) || fromSeq > toSeq) return { error: 'invalid-range' };
  const selected = turns.filter((turn) => turn.seqStart <= toSeq && turn.seqEnd >= fromSeq).sort((a, b) => a.seqStart - b.seqStart);
  const text = selected.map((turn) => `[${turn.turnId} | seq=${turn.seqStart}-${turn.seqEnd}]\n${turn.text}`).join('\n\n');
  const clipped = clipUtf8(text, maxBytes);
  return { fromSeq, toSeq, turnIds: selected.map((turn) => turn.turnId), ...clipped };
}
