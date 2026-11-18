import test from 'node:test';
import assert from 'node:assert/strict';
import { installReadSeqRangeTool } from '../src/turn-ping/read-tool-install.mjs';

const sessionQuery = {
  async readSession() {
    return { events: [
      { seq: 1981, type: 'user/message', data: { source: { kind: 'user' }, content: 'turn 1981 question' } },
      { seq: 2000, type: 'assistant/message', data: { content: 'turn 1981 answer' } },
    ] };
  },
};

function makeCtx({ registrationService = null } = {}) {
  let tool = null;
  const ctx = {
    get: () => registrationService,
    inject(deps, cb) {
      assert.deepEqual(deps, ['tools']);
      cb({
        get: () => registrationService,
        effect: (fn) => fn(),
        tools: { register: (value) => { tool = value; return () => {}; } },
      });
    },
  };
  return { ctx, getTool: () => tool };
}

const execWith = (service) => ({
  agent: {
    session: { id: 's1' },
    ctx: { get: (key) => key === 'sessionQuery' ? service : undefined },
  },
});

test('registers read_seq_range in the catalog even when service is null at install', async () => {
  const { ctx, getTool } = makeCtx();
  const installed = installReadSeqRangeTool(ctx);
  assert.ok(installed.registered);
  assert.equal(getTool().name, 'read_seq_range');
  await assert.rejects(() => getTool().execute({ fromSeq: 1981, toSeq: 2000 }, execWith(null)), /sessionQuery unavailable/);
});

test('execute resolves sessionQuery from exec.agent.ctx at call time', async () => {
  const { ctx, getTool } = makeCtx();
  installReadSeqRangeTool(ctx);
  const result = JSON.parse(await getTool().execute({ fromSeq: 1981, toSeq: 2000 }, execWith(sessionQuery)));
  assert.equal(result.seqs[0], 1981);
  assert.ok(result.text.includes('turn 1981 answer'));
  assert.equal(result.returnedBytes <= 4096, true);
  assert.match(result.rawTextSha256, /^[a-f0-9]{64}$/);
  assert.match(result.rawRecordSha256, /^[a-f0-9]{64}$/);
});

test('explicit unavailable when neither agent, scoped, nor root provides the service', async () => {
  const { ctx, getTool } = makeCtx();
  installReadSeqRangeTool(ctx);
  await assert.rejects(() => getTool().execute({ fromSeq: 1, toSeq: 2 }, { agent: { session: { id: 's1' }, ctx: {} } }), /sessionQuery unavailable/);
});
