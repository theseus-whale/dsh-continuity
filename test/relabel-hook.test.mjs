import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');

/**
 * 启动钩子的两条路径：
 *   s1 —— 没有 marker：正常建 entry、不启动迁移
 *   s2 —— 有 marker：pre-step 放行、后台只启动一次迁移
 * 它依赖 ensureSessionScaffolds(home) 与 persona 解析，所以用子进程 +
 * 临时 USERPROFILE/HOME 隔离，避免碰真实 ~/.dsh。
 */
test('有 marker 的 session 放行并只启动一次迁移；无 marker 的 session 走原路径', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-test-'));
  const home = path.join(root, 'home');
  // 与生产同构：store 在 <home>/.dsh/continuity/bc-index.jsonl，
  // session 目录在 <home>/.dsh/continuity/sessions/<id>（sessionFile 与 sessionsDir 一致）
  const continuity = path.join(home, '.dsh', 'continuity');
  const store = path.join(continuity, 'bc-index.jsonl');
  const sessions = path.join(continuity, 'sessions');
  for (const id of ['s1', 's2']) {
    fs.mkdirSync(path.join(sessions, id), { recursive: true });
    fs.writeFileSync(path.join(sessions, id, 'bc-index.jsonl'), '', 'utf8');
  }
  fs.mkdirSync(continuity, { recursive: true });
  // marker 必须在进程第一次 pre-step 之前就存在（重启场景就是这样）
  const marker2 = path.join(sessions, 's2', 'bc-index.relabel-pending.json');
  fs.writeFileSync(marker2, JSON.stringify({ fields: ['topic'], baseline: 'self-loo' }), 'utf8');

  const script = `
    import fs from 'node:fs';
    const { installBCPreStep } = await import('./src/memory/bc-pre-step.mjs');
    const handlers = {};
    const ctx = { on(name, fn) { handlers[name] = fn; }, get() { return null; } };
    let calls = 0;
    const installed = installBCPreStep(ctx, {
      enabled: true,
      storePath: ${JSON.stringify(store)},
      sessionScoped: true,
      relabelRunner: async ({ markerFile, conceptsFile, indexFile }) => {
        calls += 1;
        fs.writeFileSync(markerFile + '.called', '1', 'utf8');
        fs.writeFileSync(markerFile + '.args.json', JSON.stringify({ conceptsFile, indexFile }), 'utf8');
        return { status: 'done' };
      },
    });
    const next = async () => 'next';
    const step = (id) => handlers['agent/pre-step']({ agent: { session: { id } } }, next);

    const s1 = await step('s1');
    const callsAfterS1 = calls;
    const s2First = await step('s2');
    const callsAfterFirst = calls;
    const s2Second = await step('s2');
    await new Promise((r) => setTimeout(r, 50));
    const callsAfterSecond = calls;
    console.log(JSON.stringify({
      registered: installed?.registered,
      relabelEnabled: installed?.relabel?.enabled,
      s1, callsAfterS1,
      s2First, s2Second, callsAfterFirst, callsAfterSecond,
      s2MarkerCalled: fs.existsSync(${JSON.stringify(marker2)} + '.called'),
    }));
  `;

  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: pkgRoot,
    env: { ...process.env, USERPROFILE: home, HOME: home },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `子进程失败：${result.stderr}`);
  const out = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(out.registered, true);
  assert.equal(out.relabelEnabled, true);
  assert.equal(out.s1, 'next');
  assert.equal(out.callsAfterS1, 0, '没有 marker 的 session 不应启动迁移');
  assert.equal(out.s2First, 'next', '迁移期间 pre-step 必须直接放行');
  assert.equal(out.s2Second, 'next');
  assert.equal(out.callsAfterFirst, 1, '有 marker 时启动一次');
  assert.equal(out.callsAfterSecond, 1, '进行中不重复启动');
  assert.equal(out.s2MarkerCalled, true);
  // 迁移必须用 session 自己的词表（与 makeStep 同口径），不能用 persona/global 回退
  const argsFile = path.join(sessions, 's2', 'bc-index.relabel-pending.json.args.json');
  assert.equal(fs.existsSync(argsFile), true, 'runner 应收到参数');
  const args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  assert.equal(
    path.normalize(args.conceptsFile),
    path.normalize(path.join(sessions, 's2', 'concepts.md')),
    'conceptsFile 必须是本 session 的 concepts.md',
  );
  assert.equal(
    path.normalize(args.indexFile),
    path.normalize(path.join(sessions, 's2', 'bc-index.jsonl')),
    'indexFile 必须是本 session 的索引',
  );
  fs.rmSync(root, { recursive: true, force: true });
});
