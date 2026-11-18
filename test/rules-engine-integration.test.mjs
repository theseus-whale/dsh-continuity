import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rulesCarrierMetadata, rulesCarrierSignature } from '../src/rules-lifecycle.mjs';

// The engine resolves its host base class through process.resourcesPath. Provide
// the two host modules as inert test doubles so the real integration method can
// be imported outside Electron.
const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-host-'));
const hostPackages = path.join(hostRoot, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai');
fs.mkdirSync(path.join(hostPackages, 'dsh-compaction-basic', 'lib'), { recursive: true });
fs.mkdirSync(path.join(hostPackages, 'dsh-compaction', 'lib'), { recursive: true });
fs.writeFileSync(path.join(hostPackages, 'dsh-compaction-basic', 'lib', 'index.js'),
  'export class BasicCompactionEngine {}\nexport default BasicCompactionEngine;\n');
fs.writeFileSync(path.join(hostPackages, 'dsh-compaction', 'lib', 'index.js'),
  'export function toolPairingBalancedBefore() { return true; }\nexport function toolPairingBalancedAfter() { return true; }\n');
process.resourcesPath = hostRoot;
const { ContinuityEngine } = await import('../src/engine.mjs');

const sid = 'session-engine-test';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-engine-'));
process.env.DSH_CONTINUITY_HOME = home;
process.env.USERPROFILE = home;
process.env.HOME = home;
assert.equal(
  path.resolve(process.env.USERPROFILE, '.dsh', 'continuity', 'inject-log.jsonl'),
  path.join(home, '.dsh', 'continuity', 'inject-log.jsonl'),
);
const sessionDir = path.join(home, 'sessions', sid);
fs.mkdirSync(sessionDir, { recursive: true });
fs.writeFileSync(path.join(home, 'threads.json'), JSON.stringify({
  version: 1,
  sessions: { [sid]: { threads: [], activeId: null, pending: null } },
}, null, 2));
const rulesPath = path.join(sessionDir, 'rules.md');
const habitsPath = path.join(sessionDir, 'habits.md');

function writeRules(rules, habits) {
  fs.writeFileSync(rulesPath, rules, 'utf8');
  fs.writeFileSync(habitsPath, habits, 'utf8');
}

function fakeSession() {
  let seq = 100;
  const nodes = [];
  const events = new Map();
  const append = (type, message, opts = {}) => {
    seq += 1;
    const event = { seq, type, data: { message }, surfaceOp: opts.surfaceOp };
    if (opts.surfaceOp === undefined || opts.surfaceOp === 'append') nodes.push(seq);
    else if (opts.surfaceOp?.op === 'replace') {
      const index = nodes.indexOf(opts.surfaceOp.startSeq);
      if (index < 0) throw new Error('replace target not found');
      nodes.splice(index, 1, seq);
    }
    events.set(seq, event);
    return event;
  };
  return {
    id: sid,
    surface: { nodes },
    eventAt: (s) => events.get(s) ?? null,
    append,
    providerMessages: () => nodes.map((s) => events.get(s)?.data?.message).filter(Boolean),
    rawEvents: events,
    nodes,
  };
}

function engine() {
  const e = Object.create(ContinuityEngine.prototype);
  e.threads = { inject: true, pointersOnly: false, pin: false };
  e.threadInjectTurn = new WeakMap();
  e.rulesMsgSeq = new WeakMap();
  e.habitsMsgSeq = new WeakMap();
  e.skillMsgSeq = new WeakMap();
  e.headerState = new WeakMap();
  e.skillInjectKey = new WeakMap();
  e.rulesSizeShown = new WeakMap();
  e.saveAsked = new WeakMap();
  e.learning = new Map();
  e.learningCursor = 0;
  e.learningShown = new Set();
  e.learningAnswered = new Set();
  e.scanLearning = () => {};
  e.probeWritten = true;
  e.probe2Written = true;
  e.warnOnce = () => {};
  return e;
}

function agent(session, turn) {
  return { session, lastTurn: turn };
}

const full = (body) => body.includes('[规矩·rules.md 全文]') || body.includes('[习惯·habits.md 全文]');

test('actual injectThreadContext: three unchanged turns keep one full carrier', async () => {
  writeRules('stable rules', 'stable habits');
  const session = fakeSession();
  const e = engine();
  for (let turn = 1; turn <= 3; turn += 1) await e.injectThreadContext(agent(session, turn));
  assert.equal(session.providerMessages().filter((m) => full(m.content?.[0]?.text ?? '')).length, 1);
});

test('actual injectThreadContext: restart with persisted metadata does not append again', async () => {
  writeRules('restart rules', 'restart habits');
  const session = fakeSession();
  await engine().injectThreadContext(agent(session, 1));
  const before = session.nodes.length;
  await engine().injectThreadContext(agent(session, 2));
  assert.equal(session.nodes.length, before);
});

test('actual injectThreadContext: changed content replaces and provider sees only new full text', async () => {
  writeRules('old rules', 'old habits');
  const session = fakeSession();
  const e = engine();
  await e.injectThreadContext(agent(session, 1));
  writeRules('new rules', 'new habits');
  await e.injectThreadContext(agent(session, 2));
  const providers = session.providerMessages();
  const fulls = providers.filter((m) => full(m.content?.[0]?.text ?? ''));
  assert.equal(fulls.length, 1);
  assert.ok(fulls[0].content[0].text.includes('new rules'));
  assert.equal(fulls[0].content[0].text.includes('old rules'), false);
});

test('actual injectThreadContext: folded carrier is appended again', async () => {
  writeRules('fold rules', 'fold habits');
  const session = fakeSession();
  const e = engine();
  await e.injectThreadContext(agent(session, 1));
  session.nodes.length = 0;
  await e.injectThreadContext(agent(session, 2));
  assert.equal(session.providerMessages().filter((m) => full(m.content?.[0]?.text ?? '')).length, 1);
});

test('actual injectThreadContext: clearing both files removes the old full carrier', async () => {
  writeRules('clear rules', 'clear habits');
  const session = fakeSession();
  const e = engine();
  await e.injectThreadContext(agent(session, 1));
  writeRules('', '');
  await e.injectThreadContext(agent(session, 2));
  const providers = session.providerMessages();
  assert.equal(providers.filter((m) => full(m.content?.[0]?.text ?? '')).length, 0);
});

test('actual injectThreadContext: clearing one file keeps the other full text', async () => {
  writeRules('keep rules', 'drop habits');
  const session = fakeSession();
  const e = engine();
  await e.injectThreadContext(agent(session, 1));
  writeRules('keep rules', '');
  await e.injectThreadContext(agent(session, 2));
  const fulls = session.providerMessages().filter((m) => full(m.content?.[0]?.text ?? ''));
  assert.equal(fulls.length, 1);
  assert.ok(fulls[0].content[0].text.includes('keep rules'));
  assert.equal(fulls[0].content[0].text.includes('drop habits'), false);
});

test('actual injectThreadContext: replace failure leaves old state and can retry', async () => {
  writeRules('failure rules', 'failure habits');
  const session = fakeSession();
  const e = engine();
  await e.injectThreadContext(agent(session, 1));
  const before = session.nodes.length;
  const realAppend = session.append;
  session.append = (...args) => {
    if (args[2]?.surfaceOp?.op === 'replace') throw new Error('replace failed');
    return realAppend(...args);
  };
  writeRules('retry rules', 'retry habits');
  await assert.rejects(() => e.injectThreadContext(agent(session, 2)), /replace failed/);
  assert.equal(session.nodes.length, before);
  session.append = realAppend;
  await e.injectThreadContext(agent(session, 2));
  assert.equal(session.providerMessages().filter((m) => full(m.content?.[0]?.text ?? '')).length, 1);
});

test('actual injectThreadContext: legacy carrier is migrated', async () => {
  writeRules('legacy rules', 'legacy habits');
  const session = fakeSession();
  const event = session.append('user/message', {
    role: 'user',
    content: [{ type: 'text', text: '[规矩·rules.md 全文]\nlegacy rules' }],
    source: { kind: 'runtime-context' },
  });
  const e = engine();
  await e.injectThreadContext(agent(session, 1));
  const migrated = session.eventAt(session.nodes.at(-1));
  assert.ok(event);
  assert.equal(migrated?.data?.message?.source?.continuityRules?.version, 1);
});

function makeReadFailure(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  fs.rmSync(filePath, { force: true });
  fs.mkdirSync(filePath);
  return () => {
    fs.rmSync(filePath, { recursive: true, force: true });
    fs.writeFileSync(filePath, content, 'utf8');
  };
}

for (const which of ['rules', 'habits']) {
  test(`actual injectThreadContext: ${which} read failure keeps old carrier and retries`, async () => {
    writeRules('readfail rules', 'readfail habits');
    const session = fakeSession();
    const e = engine();
    await e.injectThreadContext(agent(session, 1));
    const beforeNodes = session.nodes.length;
    const beforeFulls = session.providerMessages().filter((m) => full(m.content?.[0]?.text ?? ''));
    const logPath = path.join(home, '.dsh', 'continuity', 'inject-log.jsonl');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, '');
    const restore = makeReadFailure(which === 'rules' ? rulesPath : habitsPath);
    try {
      await e.injectThreadContext(agent(session, 2));
      assert.equal(session.nodes.length, beforeNodes);
      assert.deepEqual(
        session.providerMessages().filter((m) => full(m.content?.[0]?.text ?? '')),
        beforeFulls,
      );
      const log = fs.readFileSync(logPath, 'utf8');
      assert.match(log, new RegExp(`"reason":"carrier-read-failed".*"which":"${which}"`));
    } finally {
      restore();
    }
    writeRules('recovered rules', 'recovered habits');
    await e.injectThreadContext(agent(session, 3));
    const recovered = session.providerMessages().filter((m) => full(m.content?.[0]?.text ?? ''));
    assert.equal(recovered.length, 1);
    assert.ok(recovered[0].content[0].text.includes('recovered rules'));
  });
}

test('direct-data carrier shape is recognized by the engine planner', async () => {
  const signature = rulesCarrierSignature('direct rules', 'direct habits');
  const session = fakeSession();
  session.append('user/message', {
    role: 'user',
    content: [{ type: 'text', text: '[规矩·rules.md 全文]\ndirect rules' }],
    source: { kind: 'runtime-context', continuityRules: rulesCarrierMetadata(signature) },
  });
  writeRules('direct rules', 'direct habits');
  const e = engine();
  await e.injectThreadContext(agent(session, 1));
  assert.equal(session.providerMessages().filter((m) => full(m.content?.[0]?.text ?? '')).length, 1);
});
