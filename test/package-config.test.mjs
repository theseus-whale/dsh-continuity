import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig } from '../src/turn-ping/config.mjs';
import { installTurnPing } from '../src/turn-ping/install.mjs';

function parseTurnPingBlock(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*turnPing:\s*$/.test(line));
  if (start < 0) throw new Error('turnPing block missing');
  const baseIndent = lines[start].match(/^\s*/)[0].length;
  const out = {};
  let section = null;
  let sectionIndent = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent <= baseIndent) break;
    const text = line.trim();
    if (text.endsWith(':') && !text.includes(': ')) {
      section = text.slice(0, -1);
      sectionIndent = indent;
      if (section === 'boundaries' || section === 'coverage') out[section] = {};
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(text);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue;
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else value = value.replace(/^['"]|['"]$/g, '');
    if (section && indent > sectionIndent) {
      out[section] = out[section] ?? {};
      out[section][key] = value;
    } else {
      section = null;
      out[key] = value;
    }
  }
  return out;
}

test('actual cordis.patch public turnPing config is safe-off and can be explicitly enabled', () => {
  const turnPing = parseTurnPingBlock(path.resolve('cordis.patch.yml'));
  assert.equal(turnPing.enabled, false);
  assert.equal(turnPing.mode, 'shadow');
  assert.equal(turnPing.boundaries.allowDefaultEnable, false);
  assert.equal(turnPing.boundaries.allowLiveInjection, false);
  assert.equal(turnPing.diagnostics.enabled, true);
  const config = readConfig(turnPing);
  assert.equal(config.enabled, false);
  assert.equal(config.mode, 'shadow');
  const installed = installTurnPing({
    config: {
      ...turnPing,
      enabled: true,
      mode: 'opt-in',
      boundaries: { ...turnPing.boundaries, allowDefaultEnable: true, allowLiveInjection: true },
    },
    provider: async () => ({ text: 'x', model: 'fake', usage: null }),
    embedder: async () => Array.from({ length: 512 }, () => 0),
    home: fs.mkdtempSync(path.join(os.tmpdir(), 'turn-ping-package-config-')),
  });
  assert.equal(installed.enabled, true);
  assert.equal(installed.host.config.mode, 'opt-in');
  assert.equal(installed.host.config.boundaries.allowLiveInjection, true);
});

test('public patch has no local session ids and uses a local unified-fold overlay', () => {
  const text = fs.readFileSync(path.resolve('cordis.patch.yml'), 'utf8');
  assert.equal(/sessionIds:/.test(text), false);
  assert.match(text, /localConfig: \.\/local\/memory-resonance\.json/);
  assert.match(text, /localConfig: \.\/local\/unified-fold\.json/);
  assert.match(text, /unifiedFold:\s*\n\s*enabled: false/);
});

test('Host panel and preset engine resolve the same scoped package', () => {
  const text = fs.readFileSync(path.resolve('cordis.patch.yml'), 'utf8');
  assert.match(
    text,
    /- id: dsh-continuity\s*\n\s*name: '@theseus-whale\/dsh-continuity'\s*\n\s*required: false/,
  );
  assert.doesNotMatch(text, /- id: dsh-continuity\s*\n\s*name: dsh-continuity\s*(?:\n|$)/);
  const engineNames = text.match(/name: '@theseus-whale\/dsh-continuity\/engine'/g) ?? [];
  assert.equal(engineNames.length, 2);
});
