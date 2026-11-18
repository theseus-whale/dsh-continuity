import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Same real-engine import seam as rules-engine-integration, with an inert host
// base that executes the actual transaction ordering around the real
// ContinuityEngine.compactRegion/summarize methods.
const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-fold-host-'));
const hostPackages = path.join(hostRoot, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai');
fs.mkdirSync(path.join(hostPackages, 'dsh-compaction-basic', 'lib'), { recursive: true });
fs.mkdirSync(path.join(hostPackages, 'dsh-compaction', 'lib'), { recursive: true });
fs.writeFileSync(path.join(hostPackages, 'dsh-compaction-basic', 'lib', 'index.js'), `
export class BasicCompactionEngine {
  async compactRegion(start, end, agent, signal) {
    const startEvent = agent.session.append('compaction/start', { compactionId: 'tx-engine', turn: 1 });
    const result = await this.summarize({}, agent, signal);
    const summaryEvent = agent.session.append('compaction/summary', { compactionId: 'tx-engine', summary: result.summary, shadowedRange: { start, end } });
    agent.session.append('user/message', { message: { content: result.summary } }, { surfaceOp: { op: 'replace', startSeq: start, endSeq: end } });
    const endEvent = agent.session.append('compaction/end', { compactionId: 'tx-engine' });
    return { compactionId: 'tx-engine', startSeq: startEvent.seq, summarySeq: summaryEvent.seq, endSeq: endEvent.seq, summary: result.summary, shadowedRange: { start, end }, shadowedSeqs: [...agent.session.surface.nodes], shadowedTokenCount: 0 };
  }
}
export default BasicCompactionEngine;
`);
fs.writeFileSync(path.join(hostPackages, 'dsh-compaction', 'lib', 'index.js'), 'export function toolPairingBalancedBefore() { return true; }\nexport function toolPairingBalancedAfter() { return true; }\n');
process.resourcesPath = hostRoot;
const { ContinuityEngine } = await import('../src/engine.mjs');

const sid = 'session-unified-engine';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-unified-'));
function makeSession() {
  let seq = 0;
  const events = [];
  const nodes = [];
  const append = (type, data, opts = {}) => {
    seq += 1;
    const event = { seq, type, data };
    events.push(event);
    if (opts.surfaceOp?.op === 'replace') {
      const at = nodes.indexOf(opts.surfaceOp.startSeq);
      if (at < 0) throw new Error('replace target missing');
      nodes.splice(at, 1, seq);
    } else nodes.push(seq);
    return event;
  };
  return { id: sid, surface: { nodes }, append, eventAt: (s) => events.find((e) => e.seq === s), snapshotEvents: () => [...events], events, nodes };
}
function event(seq, type, text, source = null) {
  return { seq, type, data: { message: { content: [{ type: 'text', text }], ...(source ? { source } : {}) } } };
}
function makeAgent() {
  const session = makeSession();
  for (const row of [event(1, 'user/message', 'u1', { kind: 'user' }), event(2, 'assistant/message', 'a1'), event(3, 'user/message', 'u2', { kind: 'user' }), event(4, 'assistant/message', 'a2')]) {
    session.events.push(row); session.nodes.push(row.seq);
  }
  return { session };
}
function engine() {
  const e = Object.create(ContinuityEngine.prototype);
  e.threadGist = new WeakMap();
  e.mechanicalNote = false;
  e.unifiedBatches = new WeakMap();
  e.unifiedCommitted = new WeakMap();
  e.unifiedHome = home;
  e.unifiedFold = { enabled: true, sessionIds: new Set([sid]), home };
  e.unifiedConfig = { summary: { maxAttempts: 2, hardMaxChars: 256, promptVersion: 'L', provider: 'fake', model: 'fake' }, sourceView: { userChars: 4000, assistantChars: 5000, toolChars: 1500, totalChars: 16000, userSourceKinds: ['user'] }, vector: { model: 'BGE', dimensions: 512 } };
  e.unifiedProvider = async ({ turn }) => ({ text: `L-${turn.turnId}`, provider: 'fake', model: 'fake' });
  e.unifiedEmbedder = async () => Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0));
  return e;
}

test('actual ContinuityEngine.compactRegion/summarize commits a unified batch after the fold transaction', async () => {
  const e = engine(); const agent = makeAgent();
  const result = await e.compactRegion(1, 4, agent);
  assert.equal(result.compactionId, 'tx-engine');
  const start = agent.session.events.find((x) => x.type === 'compaction/start');
  const summary = agent.session.events.find((x) => x.type === 'compaction/summary');
  const end = agent.session.events.find((x) => x.type === 'compaction/end');
  assert.ok(start.seq < summary.seq && summary.seq < end.seq);
  assert.equal(summary.data.summary.length, 2);
  assert.match(summary.data.summary[0].text, /\[folded turn/);
  const summaries = path.join(home, 'sessions', sid, 'turn-ping', 'turn-summaries', 'v1.jsonl');
  const vectors = path.join(home, 'sessions', sid, 'turn-ping', 'vector-index', 'v1', 'records.jsonl');
  assert.equal(fs.readFileSync(summaries, 'utf8').trim().split('\n').length, 2);
  assert.equal(fs.readFileSync(vectors, 'utf8').trim().split('\n').length, 2);
  assert.equal(e.unifiedCommitted.has(agent), true);
});

test('actual engine summarizes a closed partial surface turn from full raw events', async () => {
  fs.rmSync(path.join(home, 'sessions', sid, 'turn-ping'), { recursive: true, force: true });
  const e = engine(); const agent = makeAgent();
  for (const row of [event(5, 'user/message', 'u3', { kind: 'user' }), event(6, 'assistant/message', 'a3')]) {
    agent.session.events.push(row); agent.session.nodes.push(row.seq);
  }
  const result = await e.compactRegion(1, 5, agent);
  assert.equal(result.shadowedRange.end, 5);
  const summary = agent.session.events.find((x) => x.type === 'compaction/summary');
  assert.equal(summary.data.summary.length, 3);
  assert.equal(summary.data.summary.some((block) => block.text.includes('turn-000005')), true);
});

test('actual engine still moves an open-turn cut to the previous complete Host turn', async () => {
  fs.rmSync(path.join(home, 'sessions', sid, 'turn-ping'), { recursive: true, force: true });
  const e = engine(); const session = makeSession(); const agent = { session };
  const rows = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    event(2, 'user/message', 'u1', { kind: 'user' }), event(3, 'assistant/message', 'a1'),
    { seq: 4, type: 'turn/end', data: { turn: 1 } },
    { seq: 5, type: 'turn/start', data: { turn: 2 } },
    event(6, 'user/message', 'peer2', { kind: 'peer' }), event(7, 'assistant/message', 'a2'),
    { seq: 8, type: 'turn/end', data: { turn: 2 } },
    { seq: 9, type: 'turn/start', data: { turn: 3 } },
    event(10, 'user/message', 'peer3', { kind: 'peer' }), event(11, 'assistant/message', 'open'),
  ];
  for (const row of rows) { session.events.push(row); if (['user/message', 'assistant/message'].includes(row.type)) session.nodes.push(row.seq); }
  const result = await e.compactRegion(2, 10, agent);
  assert.equal(result.shadowedRange.end, 7);
  const summary = agent.session.events.find((x) => x.type === 'compaction/summary');
  assert.equal(summary.data.summary.length, 2);
  assert.equal(summary.data.summary.some((block) => block.text.includes('turn-000010')), false);
});

test('actual ContinuityEngine failure keeps transaction error and writes no summaries', async () => {
  fs.rmSync(path.join(home, 'sessions', sid, 'turn-ping'), { recursive: true, force: true });
  const e = engine(); const agent = makeAgent();
  e.unifiedProvider = async () => ({ text: '', provider: 'fake', model: 'fake' });
  await assert.rejects(e.compactRegion(1, 4, agent), /no valid L|provider/);
  const dir = path.join(home, 'sessions', sid, 'turn-ping', 'turn-summaries', 'v1.jsonl');
  assert.equal(fs.existsSync(dir), false);
});
