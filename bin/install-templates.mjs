#!/usr/bin/env node
/**
 * Idempotent setup for the three template files.
 *
 * Dry-run by default. `--apply` is explicit: it copies rules.md / habits.md only
 * when missing, and appends the AGENTS pointer only when absent. AGENTS is
 * backed up before any write.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const templates = path.join(root, 'templates');
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const contHome = process.env.DSH_CONTINUITY_HOME
  ? process.env.DSH_CONTINUITY_HOME
  : path.join(os.homedir(), '.dsh', 'continuity');
const agentsFile = argOf('--agents') ?? path.join(os.homedir(), '.dsh', 'AGENTS.md');
const markers = ['## Continuity 的 rules.md', '## Continuity 的规则层'];

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}
function backup(file) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dst = `${file}.bak-${stamp}`;
  fs.copyFileSync(file, dst);
  return dst;
}
function copyIfMissing(name) {
  const src = path.join(templates, name);
  const dst = path.join(contHome, name);
  if (!fs.existsSync(src)) throw new Error(`missing template: ${src}`);
  if (fs.existsSync(dst)) return `keep ${dst}`;
  if (apply) {
    fs.mkdirSync(contHome, { recursive: true });
    fs.copyFileSync(src, dst);
    return `create ${dst}`;
  }
  return `would create ${dst}`;
}
function mergeAgents() {
  const snippetSrc = path.join(templates, 'AGENTS-continuity.md');
  if (!fs.existsSync(snippetSrc)) throw new Error(`missing template: ${snippetSrc}`);
  const existing = read(agentsFile);
  if (existing === null) {
    if (apply) fs.mkdirSync(path.dirname(agentsFile), { recursive: true });
    const text = fs.readFileSync(snippetSrc, 'utf8');
    if (apply) fs.writeFileSync(agentsFile, text, 'utf8');
    return `create ${agentsFile}`;
  }
  if (markers.some((m) => existing.includes(m))) return `keep ${agentsFile} (pointer present)`;
  const text = existing.replace(/\s*$/, '') + '\n\n' + fs.readFileSync(snippetSrc, 'utf8');
  if (!apply) return `would append pointer to ${agentsFile}`;
  const bak = backup(agentsFile);
  fs.writeFileSync(agentsFile, text, 'utf8');
  return `append pointer to ${agentsFile}${bak ? ` (backup ${bak})` : ''}`;
}

console.log(`mode: ${apply ? 'APPLY' : 'DRY-RUN (use --apply)'}`);
console.log(`continuity: ${contHome}`);
console.log(`agents: ${agentsFile}`);
for (const name of ['rules.md', 'habits.md']) console.log(copyIfMissing(name));
console.log(mergeAgents());
