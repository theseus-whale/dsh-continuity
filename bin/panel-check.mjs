#!/usr/bin/env node
/**
 * Diagnose the A/B/C/K panel installation.
 *
 * Run from the installed package:
 *   node bin/panel-check.mjs --url http://127.0.0.1:3095
 *   node bin/panel-check.mjs --url http://127.0.0.1:3095 --session session-...
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const client = path.join(root, 'client.js');
const url = arg('url', process.env.DSH_WEB_URL ?? null);
const session = arg('session', null);

console.log(`package: ${pkg.name}@${pkg.version}`);
console.log(`client.js: ${fs.existsSync(client) ? 'present' : 'MISSING'}`);
console.log(`dsh.client: ${pkg.dsh?.client ? JSON.stringify(pkg.dsh.client) : 'MISSING'}`);
if (pkg.dsh?.client?.platform !== 'web') {
  console.log('warning: dsh.client.platform is not "web"; the browser UI will not load');
}
if (!url) {
  console.log('\nNo --url given. Pass the current DSH Web URL, e.g. --url http://127.0.0.1:3095');
  process.exit(0);
}
const base = url.replace(/\/+$/, '');
async function get(pathname) {
  const response = await fetch(`${base}${pathname}`, { headers: { accept: 'application/json' } });
  return { status: response.status, text: await response.text() };
}
try {
  const state = await get('/dsh-continuity/state.json');
  console.log(`state.json: HTTP ${state.status}`);
  console.log(state.text.slice(0, 300));
} catch (error) {
  console.log(`state.json: FAILED ${error.message} (is this the DSH Web URL and is the plugin loaded?)`);
}
if (session) {
  try {
    const bc = await get(`/dsh-continuity/bc.json?sessionId=${encodeURIComponent(session)}`);
    console.log(`bc.json: HTTP ${bc.status}`);
    console.log(bc.text.slice(0, 500));
  } catch (error) {
    console.log(`bc.json: FAILED ${error.message}`);
  }
}
console.log('\nIf state.json works but the sidebar has no Continuity entry, the client bundle is not mounted.');
console.log('If the left panel works but the right tab is absent, this DSH lacks sidebarRight/sidebarRightTabs.');
console.log('If the tab opens with empty tables, send one message; A/C/K start empty by design.');
