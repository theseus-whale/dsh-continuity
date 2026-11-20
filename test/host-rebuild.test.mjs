import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHostRebuildService } from '../src/fullseed/host-rebuild.mjs';
import { createMemoryRebuildTool } from '../src/fullseed/host-rebuild-tool.mjs';
import { loadActiveIndex } from '../src/fullseed/cache.mjs';

function events(count = 2) {
  return Array.from({ length: count }, (_, index) => ({
    seq: index + 1,
    type: index % 2 === 0 ? 'user/message' : 'assistant/message',
    data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: index % 2 === 0 ? `第 ${index} 轮输入` : `第 ${index} 轮决定` }] } },
  }));
}
const embedder = async () => Array.from({ length: 512 }, (_, index) => index === 0 ? 1 : 0);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('one tool call delegates full rebuild to the Host provider and atomically activates complete coverage', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'host-rebuild-tool-'));
  const sessionId = 'host-session';
  const raw = events(4);
  let calls = 0;
  const service = createHostRebuildService({
    home,
    sessionQuery: { readSession: async () => ({ events: raw }) },
    provider: async () => { calls++; return { text: `第 ${calls} 条一句摘要。`, provider: 'deepseek-official', model: 'deepseek-flash' }; },
    embedder,
    allowedSessionIds: new Set([sessionId]),
  });
  const tool = createMemoryRebuildTool({ resolveService: () => service });
  const started = JSON.parse(await tool.execute({ action: 'start' }, { agent: { session: { id: sessionId } } }));
  assert.equal(started.engine, 'host-ctx.llm');
  assert.ok(started.jobId);
  const done = await service.wait(started.jobId);
  assert.equal(done.status, 'complete');
  assert.equal(done.liveBaseId !== null, true);
  const root = path.join(home, 'sessions', sessionId, 'turn-ping', 'fullseed');
  const active = loadActiveIndex(root);
  assert.equal(active.merged.summaries.length, 2);
  assert.equal(active.merged.vectors.length, 2);
  assert.equal(calls, 2);
  assert.ok(active.merged.summaries.every(row => /^第 \d+ 条一句摘要。$/.test(row.summaryText)));
  const status = JSON.parse(await tool.execute({ action: 'status', jobId: started.jobId }, { agent: { session: { id: sessionId } } }));
  assert.equal(status.status, 'complete');
  assert.equal(status.completedChunks, 2);
});

test('cancel stops shadow work and never activates a partial live index', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'host-rebuild-cancel-'));
  const sessionId = 'cancel-session';
  let calls = 0;
  const service = createHostRebuildService({
    home,
    sessionQuery: { readSession: async () => ({ events: events(20) }) },
    provider: async () => { calls++; await sleep(20); return { text: '一句摘要。' }; },
    embedder,
  });
  const started = await service.start(sessionId);
  await service.cancel(sessionId, started.jobId);
  const stopped = await service.wait(started.jobId);
  assert.equal(stopped.status, 'cancelled');
  assert.ok(calls <= 4);
  assert.equal(fs.existsSync(path.join(home, 'sessions', sessionId, 'turn-ping', 'fullseed', 'active.json')), false);
});

test('unauthorized sessions cannot start Host rebuild work', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'host-rebuild-auth-'));
  let calls = 0;
  const service = createHostRebuildService({
    home,
    sessionQuery: { readSession: async () => ({ events: events(2) }) },
    provider: async () => { calls++; return { text: '不应执行' }; },
    embedder,
    allowedSessionIds: new Set(['allowed']),
  });
  const result = await service.start('denied');
  assert.equal(result.status, 'not-authorized');
  assert.equal(calls, 0);
});


test('package export and both Continuity presets expose memory_rebuild', async () => {
  const exported = await import('@theseus-whale/dsh-continuity/memory-rebuild-tool');
  assert.equal(exported.name, 'memory-rebuild-tool');
  const patch = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  const registrations = patch.match(/name: '@theseus-whale\/dsh-continuity\/memory-rebuild-tool'/g) ?? [];
  assert.equal(registrations.length, 2);
});


test('rebuild, status and cancel are strictly isolated to the calling session', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'host-rebuild-isolation-'));
  const continuity = 'continuity-test';
  const sonar = 'sonar-test';
  const calls = [];
  const service = createHostRebuildService({
    home,
    sessionQuery: { readSession: async id => {
      const rows = events(id === sonar ? 20 : 2);
      rows[0].data.message.content[0].text = `${id} 的原始输入`;
      rows[1].data.message.content[0].text = `${id} 的原始决定`;
      return { events: rows };
    } },
    provider: async ({ chunk }) => {
      calls.push(chunk);
      if (chunk.includes(sonar)) await sleep(30);
      return { text: '一句摘要。' };
    },
    embedder,
  });
  const started = await service.start(continuity);
  assert.equal((await service.wait(started.jobId)).status, 'complete');
  assert.equal(calls.length, 1);
  assert.match(calls[0], new RegExp(continuity));
  assert.equal(fs.existsSync(path.join(home, 'sessions', continuity, 'turn-ping', 'fullseed', 'active.json')), true);
  assert.equal(fs.existsSync(path.join(home, 'sessions', sonar, 'turn-ping', 'fullseed', 'active.json')), false);
  assert.equal(fs.existsSync(path.join(home, 'sessions', sonar, 'turn-ping', 'fullseed', 'host-rebuild-jobs')), false);
  assert.equal((await service.status(sonar, started.jobId)).status, 'none');

  const other = await service.start(sonar);
  const rejected = await service.cancel(continuity, other.jobId);
  assert.equal(rejected.status, 'not-running');
  assert.equal((await service.status(sonar, other.jobId)).status !== 'cancelled', true);
  await service.cancel(sonar, other.jobId);
  assert.equal((await service.wait(other.jobId)).status, 'cancelled');
  assert.equal(fs.existsSync(path.join(home, 'sessions', continuity, 'turn-ping', 'fullseed', 'active.json')), true);
  assert.equal(fs.existsSync(path.join(home, 'sessions', sonar, 'turn-ping', 'fullseed', 'active.json')), false);
});


test('probe performs one Host call with the current session ID and writes no job or index', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'host-rebuild-probe-'));
  const sessionId = 'probe-session';
  let seen = null;
  const service = createHostRebuildService({
    home,
    sessionQuery: { readSession: async () => ({ events: events(2) }) },
    provider: async args => { seen = args; return { text: '一条 Host 探针摘要。' }; },
    embedder,
  });
  const tool = createMemoryRebuildTool({ resolveService: () => service });
  const result = JSON.parse(await tool.execute({ action: 'probe' }, { agent: { session: { id: sessionId } } }));
  assert.equal(result.status, 'complete');
  assert.equal(result.writes, 0);
  assert.equal(result.summaryText, '一条 Host 探针摘要。');
  assert.equal(seen.sessionId, sessionId);
  assert.match(seen.prompt, /100 字/);
  assert.equal(fs.existsSync(path.join(home, 'sessions', sessionId, 'turn-ping', 'fullseed')), false);
});


test('probe reports empty-summary as failure and still writes nothing', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'host-rebuild-empty-probe-'));
  const sessionId = 'empty-probe-session';
  const service = createHostRebuildService({
    home,
    sessionQuery: { readSession: async () => ({ events: events(2) }) },
    provider: async () => ({ text: '', streamStats: { chunkTypes: { finish: 1 } } }),
    embedder,
  });
  const result = await service.probe(sessionId);
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'empty-summary');
  assert.equal(result.writes, 0);
  assert.equal(fs.existsSync(path.join(home, 'sessions', sessionId, 'turn-ping', 'fullseed')), false);
});


test('probe rejects tool/reasoning transcripts but allows a slightly long single sentence', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'host-rebuild-probe-format-'));
  const sessionId = 'format-probe-session';
  const service = createHostRebuildService({
    home,
    sessionQuery: { readSession: async () => ({ events: events(2) }) },
    provider: async () => ({ text: '<path>C:\\work\\now.md</path>\nWait, let me reason about it.' }),
    embedder,
  });
  const invalid = await service.probe(sessionId);
  assert.equal(invalid.status, 'failed');
  assert.equal(invalid.error, 'invalid-summary-format');
  assert.ok(invalid.formatErrors.includes('tool-output-tag'));
  assert.ok(invalid.formatErrors.includes('reasoning-marker'));
  assert.ok(invalid.formatErrors.includes('multiline'));
  const mildService = createHostRebuildService({
    home,
    sessionQuery: { readSession: async () => ({ events: events(2) }) },
    provider: async () => ({ text: '短'.repeat(270) }),
    embedder,
  });
  const mild = await mildService.probe(sessionId);
  assert.equal(mild.status, 'complete');
  assert.deepEqual(mild.warnings, ['soft-too-long:270']);
});


test('unavailable rebuild reports the original installation failure and diagnostic location', async () => {
  const tool = createMemoryRebuildTool({
    resolveService: () => null,
    resolveUnavailableReason: () => ({ code: 'turn-ping-install-failed', message: 'ctx.llm adapter could not initialize' }),
  });
  await assert.rejects(
    tool.execute({ action: 'probe' }, { agent: { session: { id: 'probe-session' } } }),
    /Host rebuild service unavailable; turn-ping-install-failed: ctx\.llm adapter could not initialize;.*gate-errors\.jsonl/,
  );
});


test('final counter follows activated snapshot rather than stale staging entries', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'host-rebuild-counter-'));
  const sessionId = 'counter-session';
  let reads = 0;
  const service = createHostRebuildService({
    home,
    sessionQuery: { readSession: async () => ({ events: events(++reads === 1 ? 4 : 2) }) },
    provider: async () => ({ text: '一句摘要。' }),
    embedder,
  });
  const started = await service.start(sessionId);
  const done = await service.wait(started.jobId);
  assert.equal(done.status, 'complete');
  assert.equal(done.totalChunks, 1);
  assert.equal(done.completedChunks, 1);
  assert.equal(loadActiveIndex(path.join(home, 'sessions', sessionId, 'turn-ping', 'fullseed')).merged.summaries.length, 1);
});
