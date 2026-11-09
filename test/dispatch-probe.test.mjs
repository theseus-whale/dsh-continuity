import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/index.mjs';
import { continuityState } from '../src/state.mjs';

const readProbe = async (home) => {
  const text = await readFile(join(home, '.dsh', 'continuity', 'dispatch-probe.jsonl'), 'utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
};

test('index listener writes dispatch-probe before consulting the engine', async () => {
  const home = await mkdtemp(join(tmpdir(), 'continuity-dispatch-'));
  const oldHome = process.env.USERPROFILE;
  const oldEngine = continuityState.engine;
  const oldEngineInstance = continuityState.engineInstance;
  const oldEngineSession = continuityState.engineSession;
  process.env.USERPROFILE = home;
  await mkdir(join(home, '.dsh', 'continuity'), { recursive: true });
  try {
    const handlers = new Map();
    const ctx = {
      logger: { info() {}, warn() {} },
      on(event, handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      inject(_services, callback) {
        callback({
          effect(fn) { fn(); },
          logger: { info() {} },
          webServer: { register() {} },
          tools: { register() {} },
        });
      },
    };
    apply(ctx, { panel: { enabled: false } });

    continuityState.engine = null;
    continuityState.engineInstance = null;
    continuityState.engineSession = 'session-own';
    handlers.get('agent/turn-stopping')[0]({ turn: 1195, agent: { session: { id: 'session-other' } } });
    let rows = await readProbe(home);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].event, 'agent/turn-stopping');
    assert.equal(rows[0].turn, 1195);
    assert.equal(rows[0].enginePresent, false);
    assert.equal(rows[0].engineCallable, false);
    assert.equal(rows[0].agentSession, 'session-other');
    assert.equal(rows[0].continuitySession, 'session-own');
    assert.equal(rows[0].foreignSession, true);

    let calls = 0;
    continuityState.engineInstance = { onTurnStopping() { calls += 1; } };
    handlers.get('agent/turn-stopping')[0]({ turn: 1196, agent: { session: { id: 'session-own' } } });
    rows = await readProbe(home);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].turn, 1196);
    assert.equal(rows[1].enginePresent, true);
    assert.equal(rows[1].engineCallable, true);
    assert.equal(rows[1].agentSession, 'session-own');
    assert.equal(rows[1].continuitySession, 'session-own');
    assert.equal(rows[1].foreignSession, false);
    assert.equal(calls, 1);
  } finally {
    continuityState.engine = oldEngine;
    continuityState.engineInstance = oldEngineInstance;
    continuityState.engineSession = oldEngineSession;
    if (oldHome === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});
