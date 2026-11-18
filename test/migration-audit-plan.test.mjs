import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildRawChunks } from '../src/fullseed/chunks.mjs';
import { clearActiveCache } from '../src/fullseed/cache.mjs';
import { auditSession } from '../src/migration/audit.mjs';
import { planMigration } from '../src/migration/plan.mjs';

function makeHome(valid = true) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-cli-'));
  const dir = path.join(home, 'sessions', '--workspace--', 'session-test');
  fs.mkdirSync(dir, { recursive: true });
  const events = valid ? [
    { type: 'session', version: 4, id: 'session-test' },
    { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: 'one' } },
    { seq: 2, type: 'assistant/message', data: { content: 'two' } },
    { seq: 3, type: 'user/message', data: { source: { kind: 'user' }, content: 'three' } },
    { seq: 4, type: 'assistant/message', data: { content: 'four' } },
  ] : [{ type: 'session', version: 4, id: 'wrong-session' }];
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');
  return { home, dir };
}

test('audit discovers a local raw session and reports usable chunks without writing', () => {
  const { home, dir } = makeHome();
  const before = fs.statSync(path.join(dir, 'session.v4.jsonl')).mtimeMs;
  const audit = auditSession({ dshHome: home, sessionId: 'session-test' });
  assert.equal(audit.raw.readable, true);
  assert.equal(audit.raw.checkpoint, 5);
  assert.ok(audit.chunks.count > 0);
  assert.equal(audit.chunks.rawErrors, 0);
  assert.equal(audit.existing.legacy.present, false);
  assert.equal(audit.existing.fullseed.present, false);
  assert.equal(audit.reusable, 0);
  assert.ok(audit.missing > 0);
  assert.equal(fs.statSync(path.join(dir, 'session.v4.jsonl')).mtimeMs, before);
});

test('plan is content-hashed, finite-checkpoint, no-provider, and refuses overwrite', () => {
  const { home } = makeHome();
  const result = planMigration({ dshHome: home, sessionId: 'session-test' });
  assert.equal(result.plan.status, 'plan-only-no-apply');
  assert.equal(result.plan.checkpoint, 5);
  assert.equal(Number.isInteger(result.plan.checkpoint), true);
  assert.equal(result.plan.budget.expectedProviderCalls, result.plan.missing);
  assert.equal(result.plan.budget.maxProviderCalls, result.plan.missing * 2);
  assert.equal(result.plan.budget.rootInitialCalls, 0);
  assert.equal(result.plan.missingItems.length, result.plan.missing);
  assert.equal(result.plan.itemsHash, undefined);
  assert.ok(result.plan.missingItems.every((item) => item.chunkId && item.seqStart <= item.seqEnd));
  assert.equal(result.plan.reusableItems.length, 0);
  assert.match(result.file, /plan-[0-9a-f]{16}\.json$/);
  const saved = JSON.parse(fs.readFileSync(result.file, 'utf8'));
  assert.equal(saved.contentSha256, result.plan.contentSha256);
  assert.throws(() => planMigration({ dshHome: home, sessionId: 'session-test', out: result.file }), /refusing to overwrite/);
});

test('missing/unreadable/unknown schema fails without creating a plan', () => {
  const missingHome = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-missing-'));
  assert.throws(() => planMigration({ dshHome: missingHome, sessionId: 'session-test' }), /raw not readable/);
  const { home } = makeHome(false);
  assert.throws(() => planMigration({ dshHome: home, sessionId: 'session-test' }), /raw not readable|session header/);
});

test('plan reads the actual root counter instead of resetting it', () => {
  const { home } = makeHome();
  const root = path.join(home, 'continuity', 'sessions', 'session-test', 'turn-ping', 'fullseed');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'provider-calls-root.json'), JSON.stringify({ calls: 7, at: '2026-11-18T00:00:00.000Z' }), 'utf8');
  const result = planMigration({ dshHome: home, sessionId: 'session-test' });
  assert.equal(result.plan.budget.rootInitialCalls, 7);
  assert.equal(result.plan.budget.maxProviderCalls, result.plan.missing * 2 + 7);
  assert.equal(result.plan.budget.rootCounterPath, path.join(root, 'provider-calls-root.json'));
});

test('duplicate raw discovery reports duplicate and selects canonical file; ambiguous canonical fails', () => {
  const { home, dir } = makeHome();
  const backup = path.join(home, 'sessions', '--workspace--', 'session-test-backup');
  fs.mkdirSync(backup, { recursive: true });
  fs.copyFileSync(path.join(dir, 'session.v4.jsonl'), path.join(backup, 'session.v4.jsonl'));
  const selected = auditSession({ dshHome: home, sessionId: 'session-test' });
  assert.equal(selected.raw.readable, true);
  assert.equal(selected.duplicates.count, 2);
  assert.equal(selected.duplicates.chosen, path.join(dir, 'session.v4.jsonl'));

  const a = path.join(home, 'sessions', '--a--', 'session-test');
  const b = path.join(home, 'sessions', '--b--', 'session-test');
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(a, 'session.v4.jsonl'), JSON.stringify({ type: 'session', version: 4, id: 'session-test' }) + '\n', 'utf8');
  fs.writeFileSync(path.join(b, 'session.v4.jsonl'), JSON.stringify({ type: 'session', version: 3, id: 'session-test' }) + '\n', 'utf8');
  const ambiguous = auditSession({ dshHome: home, sessionId: 'session-test' });
  assert.equal(ambiguous.canPlan, false);
  assert.equal(ambiguous.issues[0].kind, 'duplicate-ambiguous');
});

test('reuse requires exact chunk, non-empty matching summary sha, valid cutoff, and 512D vector', () => {
  const { home, dir } = makeHome();
  const events = fs.readFileSync(path.join(dir, 'session.v4.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const chunks = buildRawChunks('session-test', events, { checkpointSeq: 5 }).chunks;
  const chunk = chunks[0];
  const root = path.join(home, 'continuity', 'sessions', 'session-test', 'turn-ping', 'fullseed');
  const base = path.join(root, 'bases', 'base-test');
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(root, 'active.json'), JSON.stringify({ baseId: 'base-test', deltaIds: [], checkpoint: 5, pending: 0 }), 'utf8');
  const summaryText = 'reusable summary';
  const summary = { chunkId: chunk.chunkId, turnId: chunk.turnId, chunkIndex: chunk.chunkIndex, seqStart: chunk.seqStart, seqEnd: chunk.seqEnd, rawTextSha256: chunk.rawTextSha256, eventOffsets: chunk.eventOffsets, summaryText, summarySha256: createHash('sha256').update(summaryText).digest('hex'), availableCutoff: 5 };
  fs.writeFileSync(path.join(base, 'summaries.jsonl'), JSON.stringify(summary) + '\n', 'utf8');
  fs.writeFileSync(path.join(base, 'vector-records.jsonl'), JSON.stringify({ chunkId: chunk.chunkId, summarySha256: summary.summarySha256, dimensions: 512, offset: 0 }) + '\n', 'utf8');
  fs.writeFileSync(path.join(base, 'vectors.f32'), Buffer.alloc(512 * 4));
  const valid = planMigration({ dshHome: home, sessionId: 'session-test' });
  assert.equal(valid.plan.reusable, 1);
  assert.equal(valid.plan.reusableItems[0].chunkId, chunk.chunkId);
  assert.equal(valid.plan.reusableItems[0].summarySha256, summary.summarySha256);
  assert.equal(valid.plan.missingItems.some((item) => item.chunkId === chunk.chunkId), false);

  fs.writeFileSync(path.join(base, 'summaries.jsonl'), JSON.stringify({ ...summary, summaryText: '', summarySha256: summary.summarySha256 }) + '\n', 'utf8');
  clearActiveCache(root);
  const invalid = auditSession({ dshHome: home, sessionId: 'session-test' });
  assert.equal(invalid.reusable, 0);
  assert.ok(invalid.issues.some((issue) => issue.kind === 'fullseed-summary-empty'));
});

test('CLI dsh-continuity migrate audit discovers sessions without --session', () => {
  const { home } = makeHome();
  const cli = path.resolve('bin/continuity-migrate.mjs');
  const listed = JSON.parse(execFileSync(process.execPath, [cli, 'migrate', 'audit', '--dsh-home', home], { encoding: 'utf8' }));
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].sessionId, 'session-test');
  assert.equal(listed.sessions[0].raw.readable, true);
});

test('CLI dsh-continuity migrate audit/plan works from package entrypoint', () => {
  const { home } = makeHome();
  const cli = path.resolve('bin/continuity-migrate.mjs');
  const audit = JSON.parse(execFileSync(process.execPath, [cli, 'migrate', 'audit', '--dsh-home', home, '--session', 'session-test'], { encoding: 'utf8' }));
  assert.equal(audit.raw.readable, true);
  assert.ok(audit.chunks.count > 0);
  const plan = JSON.parse(execFileSync(process.execPath, [cli, 'migrate', 'plan', '--dsh-home', home, '--session', 'session-test'], { encoding: 'utf8' }));
  assert.equal(plan.command, 'migrate plan');
  assert.equal(plan.expectedProviderCalls, plan.missing);
  assert.ok(fs.existsSync(plan.file));
});
