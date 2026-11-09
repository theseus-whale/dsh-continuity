/**
 * 0.2.0 acceptance over the real Continuity session log.
 *
 * Read-only: decodes the multi-frame JSONL artifact and feeds the same pure
 * functions and ToolDefinition the model uses. No Host, no writes.
 *
 *   node tools/acceptance-0.2.0.mjs
 *   node tools/acceptance-0.2.0.mjs <session.v4.jsonl.zstd>
 */
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { buildIndex, getRange, grepRange, parsePointer } from '../src/session-log.mjs';
import { createSessionLogTool } from '../src/session-log-tool.mjs';

const DEFAULT_LOG = 'C:\\Users\\35794\\.dsh\\sessions\\--C-Users-35794-Documents-DeepSeek~0027s~0020Sandbox--\\session-0b094f6e-8a4b-4c61-9ce8-0aec316c57b3\\session.v4.jsonl.zstd';
const file = process.argv[2] ?? DEFAULT_LOG;
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

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
      // ignore a false-positive magic inside compressed data
    }
  }
  return text;
}

const events = [];
for (const line of decodeFrames(readFileSync(file)).split('\n')) {
  if (!line.trim()) continue;
  try {
    events.push(JSON.parse(line));
  } catch {
    // skip a torn line
  }
}

const header = events.find((event) => event.type === 'session');
const sessionId = header?.id ?? 'unknown';
const gists = events.filter((event) => event.type === 'compaction/summary');
const latest = gists.at(-1);
const gistHeader = latest?.data?.summary?.[0]?.text?.split('\n').find((line) => line.trim().startsWith('[gist'))?.trim()
  ?? null;
const range = latest?.data?.shadowedRange ?? null;

const tool = createSessionLogTool({
  sessionQuery: {
    async readSession(id) {
      if (id !== sessionId) throw new Error('SESSION_NOT_FOUND');
      return { events };
    },
  },
});
const exec = { agent: { id: sessionId }, signal: new AbortController().signal };

console.log('=== 0.2.0 acceptance:', sessionId, '·', events.length, 'events ·', gists.length, 'gists');
console.log('latest gist header:', gistHeader);
console.log('latest surface range:', JSON.stringify(range), '·', latest?.data?.shadowedSeqs?.length, 'events');

console.log('\n=== 1) index (no pointer / discovery)');
console.log((await tool.execute({ action: 'index', limit: 3 }, exec)).split('\n').slice(0, 10).join('\n'));

console.log('\n=== 2) get: a gist-pointer range resolves exact shadowed seqs and truncates');
const pointer = gistHeader ?? `log:${sessionId}#seq=${range?.start}-${range?.end}`;
const rangeResult = await tool.execute({ action: 'get', session: pointer, limit: 5 }, exec);
console.log(rangeResult.split('\n').slice(0, 14).join('\n'));

console.log('\n=== 3) get: a specific raw original inside that gist (seq 1604)');
const specific = await tool.execute({ action: 'get', session: pointer, seq: 1604, context: 1 }, exec);
console.log(specific.split('\n').slice(0, 12).join('\n'));

console.log('\n=== 4) grep: no pointer → grep → get');
const needle = '鲸鳍不是尖刀';
const hits = await tool.execute({ action: 'grep', query: needle, limit: 3, context: 0 }, exec);
console.log(hits);
const firstSeq = Number(/seq=(\d+)/.exec(hits)?.[1] ?? 0);
if (firstSeq > 0) {
  console.log('\n--- get the grep hit ± 1 ---');
  console.log((await tool.execute({ action: 'get', session: sessionId, seq: firstSeq, context: 1 }, exec)).split('\n').slice(0, 12).join('\n'));
}

console.log('\n=== 5) unavailable original: only the gist');
try {
  await tool.execute({ action: 'get', session: sessionId, seq: 999_999 }, exec);
} catch (error) {
  console.log(error.message);
}

console.log('\n=== 6) parse checks');
console.log(parsePointer(pointer));
const pure = getRange({ sessionId, events, start: range?.start, end: range?.end, limit: 3 });
console.log({ total: pure.total, returned: pure.returned, truncated: pure.truncated });
const index = buildIndex({ sessionId, events, limit: 2 });
console.log({ gists: index.total, returned: index.returned, truncated: index.truncated });
const grep = grepRange({ sessionId, events, query: 'Codex', limit: 2 });
console.log({ matches: grep.total, returned: grep.returned });
