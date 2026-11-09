/**
 * Read-only scan of the local DSH session logs for compaction records.
 *
 * The JSONL artifacts are concatenated zstd frames. Node's one-shot
 * `zstdDecompressSync` stops after the first frame, so this script splits the
 * file at the Zstandard magic (`28 B5 2F FD`) and decodes each frame. The
 * persistence package's own scanner is stricter; this is for diagnostics only
 * and never writes.
 *
 *   node tools/scan-sessions.mjs
 *   node tools/scan-sessions.mjs <sessions-root>
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const root = process.argv[2] ?? join(process.env.USERPROFILE ?? '', '.dsh', 'sessions');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function* walk(dir, depth = 0) {
  if (depth > 6) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) yield* walk(path, depth + 1);
    else yield path;
  }
}

function decodeFrames(buffer) {
  const offsets = [];
  let at = 0;
  while (true) {
    const index = buffer.indexOf(MAGIC, at);
    if (index < 0) break;
    offsets.push(index);
    at = index + 4;
  }
  let text = '';
  for (let index = 0; index < offsets.length; index += 1) {
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length;
    try {
      text += zstdDecompressSync(buffer.subarray(offsets[index], end)).toString('utf8');
    } catch {
      // A false-positive magic inside compressed data: skip that slice.
    }
  }
  return text;
}

const counts = new Map();
const summaries = [];
const summaryById = new Map();
const transactions = new Map();
let files = 0;
let events = 0;

for (const file of walk(root)) {
  if (!file.endsWith('.jsonl.zstd')) continue;
  files += 1;
  const text = decodeFrames(readFileSync(file));
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    events += 1;
    if (event.type === 'user/message' && event.data?.source?.kind === 'compact-checkpoint') {
      const summary = summaryById.get(event.data.source.compactionId);
      if (summary) {
        summary.replacementSeq = event.seq;
        summary.surfaceOp = event.surfaceOp;
      }
      continue;
    }
    if (!event.type?.startsWith('compaction/')) continue;
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
    if (event.type === 'compaction/start') {
      transactions.set(event.data?.compactionId, { startSeq: event.seq, file });
    }
    if (event.type === 'compaction/end') {
      const entry = transactions.get(event.data?.compactionId);
      if (entry) entry.endSeq = event.seq;
      const summary = summaryById.get(event.data?.compactionId);
      if (summary) summary.endSeq = event.seq;
      continue;
    }
    if (event.type === 'compaction/summary') {
      const entry = transactions.get(event.data?.compactionId) ?? {};
      const summary = {
        compactionId: event.data?.compactionId,
        startSeq: entry.startSeq,
        endSeq: entry.endSeq,
        summarySeq: event.seq,
        replacementSeq: undefined,
        file: file.split('sessions').pop(),
        shadowedRange: event.data?.shadowedRange,
        shadowedSeqs: event.data?.shadowedSeqs?.length,
        shadowedTokenCount: event.data?.shadowedTokenCount,
        provider: event.data?.provider,
        model: event.data?.model,
        maxTokens: event.data?.maxTokens,
        usage: event.data?.usage,
        summaryStart: event.data?.summary?.[0]?.text?.slice(0, 140),
      };
      summaries.push(summary);
      summaryById.set(summary.compactionId, summary);
    }
  }
}

console.log(`scanned ${files} artifacts, ${events} events`);
console.log('compaction types:', Object.fromEntries(counts));
console.log(`summary compactions: ${summaries.length}`);
for (const summary of summaries) {
  console.log(JSON.stringify(summary));
}
