#!/usr/bin/env node
import path from 'node:path';
import { auditAll, auditSession } from '../src/migration/audit.mjs';
import { planMigration } from '../src/migration/plan.mjs';
import { readPlan, applyMigration } from '../src/migration/apply.mjs';
import { verifyMigration } from '../src/migration/verify.mjs';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
function dshHome() {
  const explicit = arg('--dsh-home');
  if (explicit) return path.resolve(explicit);
  const base = process.env.USERPROFILE ?? process.env.HOME ?? '';
  return path.join(base, '.dsh');
}
function subcommand() {
  const args = process.argv.slice(2).filter((value) => !value.startsWith('--'));
  return args[0] === 'migrate' ? args[1] : args[0];
}
const command = subcommand();
const home = dshHome();
const session = arg('--session');
try {
  if (command === 'audit') {
    if (!session) {
      const result = auditAll({ dshHome: home });
      console.log(JSON.stringify({ command: 'migrate audit', dshHome: home, sessions: result.rows, duplicates: result.duplicates, unreadable: result.unreadable }, null, 2));
      if (result.rows.some((row) => !row.raw?.readable || !row.canPlan)) process.exitCode = 1;
    } else {
      const result = auditSession({ dshHome: home, sessionId: session, rawPath: arg('--raw') });
      console.log(JSON.stringify(result, null, 2));
      if (!result.raw?.readable || !result.canPlan) process.exitCode = 1;
    }
  } else if (command === 'plan') {
    if (!session) throw new Error('usage: dsh-continuity migrate plan --session <id> [--out <plan.json>] [--dsh-home <dir>]');
    const result = planMigration({ dshHome: home, sessionId: session, out: arg('--out') });
    console.log(JSON.stringify({ command: 'migrate plan', file: result.file, fileSha256: result.fileSha256, contentSha256: result.plan.contentSha256, missing: result.plan.missing, reusable: result.plan.reusable, expectedProviderCalls: result.plan.budget.expectedProviderCalls, checkpoint: result.plan.checkpoint, status: result.plan.status }, null, 2));
  } else if (command === 'apply' || command === 'resume') {
    const planFile = arg('--plan');
    if (!planFile) throw new Error(`usage: dsh-continuity migrate ${command} --plan <plan.json> --approve --provider-module <file>`);
    if (!process.argv.includes('--approve')) throw new Error(`${command}: --approve required`);
    const loaded = readPlan(planFile);
    const modulePath = arg('--provider-module');
    if (!modulePath) throw new Error(`${command}: --provider-module required`);
    const { pathToFileURL } = await import('node:url');
    const module = await import(pathToFileURL(path.resolve(modulePath)).href);
    if (typeof module.createProvider !== 'function') throw new Error(`${command}: provider module must export createProvider`);
    const { provider, embedder } = await module.createProvider();
    const result = await applyMigration({ planFile, plan: loaded.plan, provider, embedder, resume: command === 'resume' });
    console.log(JSON.stringify({ command: `migrate ${command}`, ...result }, null, 2));
  } else if (command === 'verify') {
    const planFile = arg('--plan');
    if (!planFile) throw new Error('usage: dsh-continuity migrate verify --plan <plan.json> --query <text>');
    const loaded = readPlan(planFile);
    const modulePath = arg('--provider-module') ?? arg('--embedder-module');
    let embedder = null;
    if (modulePath) {
      const { pathToFileURL } = await import('node:url');
      const module = await import(pathToFileURL(path.resolve(modulePath)).href);
      if (typeof module.createEmbedder === 'function') embedder = await module.createEmbedder();
      else if (typeof module.createProvider === 'function') ({ embedder } = await module.createProvider());
      else throw new Error('verify: module must export createEmbedder or createProvider');
    }
    const result = await verifyMigration({ plan: loaded.plan, query: arg('--query', ''), embedder });
    console.log(JSON.stringify({ command: 'migrate verify', ...result }, null, 2));
    if (!result.ok) process.exitCode = 1;
  } else {
    console.error('usage: dsh-continuity migrate <audit|plan|apply|resume|verify> [options]');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(JSON.stringify({ error: String(error?.message ?? error), command }, null, 2));
  process.exitCode = 1;
}
