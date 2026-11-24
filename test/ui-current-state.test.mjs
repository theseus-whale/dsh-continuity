import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCurrentState, createCurrentStateHandler, buildGlobalPanelExtras } from '../src/index.mjs';
import { getTurnPingHost, setTurnPingHost } from '../src/turn-ping/registry.mjs';
import { continuityState, markEngine, markEngineSession, recordError, resetState } from '../src/state.mjs';
import { writeBase, activate } from '../src/fullseed/storage.mjs';

function fakeCtx({ sessionId = 'session-ui-test' } = {}) {
  const agent = { id: sessionId, session: { id: sessionId, header: { agentPreset: 'continuity' } } };
  return {
    get(name) {
      if (name === 'agents') return { list: () => [agent] };
      if (name === 'sessionQuery') return { readSession: async () => ({ events: [] }) };
      if (name === 'sessionProjections') return { stateOf: () => 'continuity' };
      return null;
    },
    locale: {},
    slots: {},
  };
}

test('current UI state reports real session/disabled defaults, not hardcoded examples', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-current-'));
  const previous = process.env.DSH_CONTINUITY_HOME;
  process.env.DSH_CONTINUITY_HOME = home;
  try {
    const state = await buildCurrentState(fakeCtx(), null);
    assert.equal(state.session.id, 'session-ui-test');
    assert.equal(state.session.preset, 'continuity');
    assert.equal(state.memoryResonance.enabled, false);
    assert.equal(state.unifiedFold.enabled, false);
    assert.equal(state.migration.plan, null);
    assert.equal(state.plugin.version, JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).version);
    assert.equal(state.diagnostics.hostServices.sessionQuery, true);
  } finally {
    if (previous === undefined) delete process.env.DSH_CONTINUITY_HOME; else process.env.DSH_CONTINUITY_HOME = previous;
  }
});

test('current UI state reads an actual fullseed base and prints counts', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-current-active-'));
  const previous = process.env.DSH_CONTINUITY_HOME;
  process.env.DSH_CONTINUITY_HOME = home;
  try {
    const root = path.join(home, 'sessions', 'session-ui-test', 'turn-ping', 'fullseed');
    writeBase(root, { baseId: 'base-ui', summaries: [{ chunkId: 'c1', rawTextSha256: 'raw', seqStart: 1, seqEnd: 2, summaryText: 's', summarySha256: 'sha', availableCutoff: 7, turnId: 't1' }], vectors: [Array(512).fill(0)], identity: 'id', checkpoint: 7, snapshotBoundary: 7 });
    activate(root, { baseId: 'base-ui', deltaIds: [], identity: 'id', checkpoint: 7, snapshotBoundary: 7, pending: 0 });
    fs.writeFileSync(path.join(home, 'turn-ping-prestep-debug.jsonl'), `${JSON.stringify({ kind: 'return', appended: true, sessionId: 'session-ui-test', at: '2026-11-18T00:00:00.000Z', lastSourceKind: 'user', lastTextSha256: 'cuehash' })}\n`, 'utf8');
    const staging = path.join(root, 'staging', 'abc');
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'summaries.jsonl'), '{}\n{}\n', 'utf8');
    fs.writeFileSync(path.join(staging, 'vectors.jsonl'), '{}\n', 'utf8');
    const migration = path.join(home, 'sessions', 'session-ui-test', 'migration');
    fs.mkdirSync(migration, { recursive: true });
    fs.writeFileSync(path.join(migration, 'plan-abc.json'), JSON.stringify({ contentSha256: 'plan', status: 'plan-only-no-apply', missing: 1, reusable: 0, chunkSet: { count: 1 }, budget: { rootInitialCalls: 0, maxProviderCalls: 2 }, active: { legacy: { preserved: true } } }), 'utf8');
    const state = await buildCurrentState(fakeCtx(), 'session-ui-test', { turnPing: { enabled: true, sessionIds: ['session-ui-test'] } });
    assert.equal(state.memoryResonance.enabled, true);
    assert.equal(state.memoryResonance.allowed, true);
    assert.equal(state.memoryResonance.summaries, 1);
    assert.equal(state.memoryResonance.vectors, 1);
    assert.equal(state.memoryResonance.checkpoint, 7);
    assert.equal(state.memoryResonance.availableCutoff, 7);
    assert.equal(state.memoryResonance.latestCue.source, 'user');
    assert.equal(state.memoryResonance.latestCue.hash, 'cuehash');
    assert.equal(state.memoryResonance.latestCue.text, undefined);
    assert.equal(state.migration.staging.pending, 'unknown');
    assert.equal(state.migration.resume.state, 'staging-present-unverified');
    assert.equal(state.migration.legacyActivePreserved, true);
  } finally {
    if (previous === undefined) delete process.env.DSH_CONTINUITY_HOME; else process.env.DSH_CONTINUITY_HOME = previous;
  }
});

test('fold and cue state are isolated per session and explicit about unobserved fields', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-isolation-'));
  const previous = process.env.DSH_CONTINUITY_HOME;
  process.env.DSH_CONTINUITY_HOME = home;
  const saved = { passes: continuityState.passes, instance: continuityState.engineInstance, session: continuityState.engineSession };
  try {
    continuityState.passes = [
      { sessionId: 'session-b', start: 50, end: 90, count: 40, at: 2 },
      { sessionId: 'session-ui-test', start: 1, end: 5, count: 4, at: 1 },
    ];
    continuityState.engineInstance = { unifiedFold: { sessionIds: new Set(['session-ui-test']) } };
    continuityState.engineSession = 'session-ui-test';
    fs.writeFileSync(path.join(home, 'turn-ping-prestep-debug.jsonl'), [
      JSON.stringify({ kind: 'return', appended: true, sessionId: 'session-ui-test', lastSourceKind: 'user', lastTextSha256: 'mine', at: '2026-11-18T00:00:00.000Z' }),
      JSON.stringify({ kind: 'return', appended: true, sessionId: 'session-b', lastSourceKind: 'peer', lastTextSha256: 'other', at: '2026-11-18T00:01:00.000Z' }),
      JSON.stringify({ kind: 'query', sessionId: null, textSha256: 'global', at: '2026-11-18T00:02:00.000Z' }),
    ].join('\n') + '\n', 'utf8');
    const state = await buildCurrentState(fakeCtx(), 'session-ui-test', { turnPing: { enabled: true, sessionIds: ['session-ui-test'] } });
    assert.equal(state.unifiedFold.enabled, true);
    assert.equal(state.unifiedFold.lastFold.selected, 4);
    assert.equal(state.unifiedFold.reinjection, 'not-observed');
    assert.equal(state.unifiedFold.pending, 'not-observed');
    assert.equal(state.unifiedFold.recovered, 'not-observed');
    assert.equal(state.memoryResonance.latestCue.hash, 'mine');
    assert.equal(state.memoryResonance.latestCue.source, 'user');
    assert.equal(state.memoryResonance.retrieval.status, 'service-available');
  } finally {
    continuityState.passes = saved.passes;
    continuityState.engineInstance = saved.instance;
    continuityState.engineSession = saved.session;
    if (previous === undefined) delete process.env.DSH_CONTINUITY_HOME; else process.env.DSH_CONTINUITY_HOME = previous;
  }
});

test('engine mount is not inherited by another session', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-engine-scope-'));
  const previous = process.env.DSH_CONTINUITY_HOME;
  process.env.DSH_CONTINUITY_HOME = home;
  resetState();
  try {
    markEngine({ policy: {}, instance: { unifiedFold: { sessionIds: new Set(['session-a']) } } });
    markEngineSession('session-a');
    const current = await buildCurrentState(fakeCtx({ sessionId: 'session-b' }), 'session-b');
    assert.equal(current.session.engineMounted, false);
    assert.equal(current.session.engineScope, 'other-session');
    assert.equal(JSON.stringify(current.session).includes('session-a'), false);
  } finally {
    resetState();
    if (previous === undefined) delete process.env.DSH_CONTINUITY_HOME; else process.env.DSH_CONTINUITY_HOME = previous;
  }
});

test('active index does not imply enabled; enabled without active is reported separately', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-enabled-'));
  const previous = process.env.DSH_CONTINUITY_HOME;
  process.env.DSH_CONTINUITY_HOME = home;
  try {
    const root = path.join(home, 'sessions', 'session-ui-test', 'turn-ping', 'fullseed');
    writeBase(root, { baseId: 'base-off', summaries: [], vectors: [], identity: 'id', checkpoint: 1, snapshotBoundary: 1 });
    activate(root, { baseId: 'base-off', deltaIds: [], identity: 'id', checkpoint: 1, snapshotBoundary: 1, pending: 0 });
    const disabled = await buildCurrentState(fakeCtx(), 'session-ui-test', { turnPing: { enabled: false, sessionIds: [] } });
    assert.equal(disabled.memoryResonance.active, true);
    assert.equal(disabled.memoryResonance.enabled, false);
    assert.equal(disabled.memoryResonance.allowed, false);
    const noActive = await buildCurrentState(fakeCtx({ sessionId: 'session-other' }), 'session-other', { turnPing: { enabled: true, sessionIds: ['session-other'] } });
    assert.equal(noActive.memoryResonance.enabled, true);
    assert.equal(noActive.memoryResonance.active, false);
    assert.equal(noActive.memoryResonance.readiness, 'no-active');
  } finally {
    if (previous === undefined) delete process.env.DSH_CONTINUITY_HOME; else process.env.DSH_CONTINUITY_HOME = previous;
  }
});

test('Host current route injects mocked state and is read-only on GET', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-route-'));
  const previous = process.env.DSH_CONTINUITY_HOME;
  process.env.DSH_CONTINUITY_HOME = home;
  try {
    const handler = createCurrentStateHandler(fakeCtx(), () => ({ turnPing: { enabled: true, sessionIds: ['session-ui-test'] } }));
    let status = null;
    let body = '';
    const res = { writeHead(code) { status = code; }, end(text = '') { body += text; } };
    await handler({ method: 'GET', url: '/dsh-continuity/current.json?sessionId=session-ui-test', headers: {} }, res);
    assert.equal(status, 200);
    const parsed = JSON.parse(body);
    assert.equal(parsed.session.id, 'session-ui-test');
    assert.equal(parsed.memoryResonance.enabled, true);
    assert.equal(parsed.memoryResonance.active, false);
  } finally {
    if (previous === undefined) delete process.env.DSH_CONTINUITY_HOME; else process.env.DSH_CONTINUITY_HOME = previous;
  }
});

test('panel keeps waterline/projection and excludes session-local fold history', () => {
  const host = fs.readFileSync(path.resolve('src/index.mjs'), 'utf8');
  const client = fs.readFileSync(path.resolve('client.js'), 'utf8');
  assert.equal(host.includes('scoped.webServer.register(route)'), true);
  assert.equal(client.includes("const STATE_URL = '/dsh-continuity/state.json'"), true);
  assert.equal(client.includes('fetch(STATE_URL'), true);
  for (const component of ['function BandBar(', 'function Projection(']) {
    assert.equal(client.includes(component), true, `missing ${component}`);
  }
  assert.equal(client.includes('h(BandBar, { t, policy })'), true);
  assert.equal(client.includes('h(Projection, { t, projection: data?.projection ?? null })'), true);
  assert.equal(/function Passes\(|passes\.|最近折叠|Recent folds/.test(client), false);
  assert.equal(client.includes('data?.engine?.policy'), true);
  for (const removed of [/A \/ B \/ C \/ K/, /ABCK/i, /\bgist\b/i, /session_log/i, /0\.2\.1-rc\.3/, /sidebarRightTabs|sidebarRight|TagsPanel|GuideTagsRow/]) {
    assert.equal(removed.test(client), false, `obsolete UI remains: ${removed}`);
  }
  assert.equal(client.includes("inject: ['slots', 'locale']"), true);
  assert.equal(client.includes('peer_message'), false);
  for (const marker of ['function RuntimeStatus(', 'function ToolCatalog(', "'runtime.title'", "'tools.title'", 'read_seq_range', 'read_raw_chunk', 'memory_related', 'memory_recall 找回忆点', '0 非法']) {
    assert.equal(client.includes(marker), true, `missing ${marker}`);
  }
});

test('runtime and tool catalog use observed host state without claiming unobserved success', () => {
  const previous = getTurnPingHost();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-runtime-'));
  try {
    setTurnPingHost({
      home,
      config: { enabled: true, sessionIds: ['session-a'], vector: { model: 'BAAI/bge-small-zh-v1.5' } },
      rawIndexFor: () => ({ status: () => ({ records: 3, lastReconcile: { at: '2026-01-01T00:00:00Z' } }) }),
    });
    const result = buildGlobalPanelExtras(null, [{
      sessionId: 'session-a',
      toolDetailsObserved: true,
      toolDetails: [{ name: 'read_seq_range', description: 'Read exact raw text', parameters: { properties: { fromSeq: {}, toSeq: {} } } }],
    }], { provider: 'deepseek-official', model: 'deepseek-flash', available: true });
    assert.equal(result.runtime.model.metadataResolved, true);
    assert.equal(result.runtime.bge.vectors, 0);
    assert.equal(result.runtime.bge.status, 'not-observed');
    assert.equal(result.runtime.writeIndex.records, 3);
    assert.equal(result.runtime.writeIndex.reconciledSessions, 1);
    assert.equal(result.runtime.authorizedSessions, 1);
    assert.equal(result.runtime.recentErrors.length, 0);
    assert.equal(result.toolCatalog.observed, true);
    assert.equal(result.toolCatalog.tools.length, 8);
    assert.equal(result.toolCatalog.tools.find((tool) => tool.name === 'read_seq_range').visibleSessions, 1);
    const unobserved = buildGlobalPanelExtras(null, [], { provider: 'deepseek-official', model: 'deepseek-flash', available: true });
    assert.equal(unobserved.toolCatalog.observed, false);
    assert.equal(unobserved.toolCatalog.tools.length, 8);
    assert.equal(unobserved.toolCatalog.tools.every((tool) => tool.visibleSessions === 0), true);
  } finally {
    setTurnPingHost(previous);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('fold errors retain their source session for diagnostics', () => {
  resetState();
  try {
    recordError('fold failed', 'compact', 'session-a');
    const result = buildGlobalPanelExtras(null, [], {});
    assert.equal(result.runtime.recentErrors[0].sessionId, 'session-a');
    assert.equal(result.runtime.recentErrors[0].key, 'compact');
  } finally { resetState(); }
});
