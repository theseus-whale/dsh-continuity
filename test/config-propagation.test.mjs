import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const packagePatch = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
const hostStart = packagePatch.indexOf('- insert:');
const presetStart = packagePatch.indexOf('    - id: preset-continuity');
const hostText = packagePatch.slice(hostStart, presetStart);
const presetText = packagePatch.slice(presetStart);

test('Cordis same-id config patch replaces, not deep-merges', () => {
  // Exact rule from cordis-plugin-include/src/patch.ts: for non-insert patches,
  // target[key] = value, so config is replaced wholesale.
  const apply = (data, patches) => {
    const copy = structuredClone(data);
    for (const patch of patches) {
      const target = copy.find((entry) => entry.id === patch.id);
      const { id, insert, name, ...overrides } = patch;
      for (const [key, value] of Object.entries(overrides)) target[key] = value;
    }
    return copy;
  };
  const base = [{ id: 'dsh-continuity', config: { turnPing: { enabled: true, foldWrites: false }, panel: { enabled: true } } }];
  const patched = apply(base, [{ id: 'dsh-continuity', config: { unifiedFold: { enabled: true } } }]);
  assert.deepEqual(patched[0].config, { unifiedFold: { enabled: true } });
  assert.equal(patched[0].config.turnPing, undefined);
});

test('Host dsh-continuity keeps full turnPing/panel/projection/extraction/bcRecall config and has no unifiedFold', () => {
  assert.match(hostText, /turnPing:\s*\n\s+enabled: false/);
  assert.match(hostText, /foldWrites: false/);
  assert.match(hostText, /diagnostics:\s*\n\s+enabled: true/);
  assert.match(hostText, /useHostAdapters: true/);
  assert.match(hostText, /panel:\s*\n\s+enabled: true/);
  assert.match(hostText, /projection:/);
  assert.match(hostText, /extraction:/);
  assert.match(hostText, /bcRecall:/);
  assert.doesNotMatch(hostText, /unifiedFold:/);
});

test('both preset continuity-engine configs carry the same safe local-overlay unifiedFold', () => {
  const sections = presetText.split(/(?=    - id: preset-continuity)/).filter(Boolean);
  assert.equal(sections.length, 2);
  for (const section of sections) {
    assert.match(section, /- id: continuity-engine/);
    assert.match(section, /policy:\s*\n\s+setpoint: 0\.76/);
    assert.match(section, /mechanicalNote: false/);
    assert.match(section, /threads:\s*\n\s+inject: true/);
    assert.match(section, /provenance:\s*\n\s+header: false/);
    assert.match(section, /compactionBasic:\s*\n\s+thresholdRatio: 0\.8/);
    assert.match(section, /unifiedFold:\s*\n\s+enabled: false/);
    assert.match(section, /localConfig: \.\/local\/unified-fold\.json/);
    assert.doesNotMatch(section, /sessionIds:\s*\n/);
    assert.doesNotMatch(section, /providerId: deepseek-official/);
    assert.doesNotMatch(section, /model: deepseek-flash/);
    assert.match(section, /embeddingModel: \.\/models\/Xenova\/bge-small-zh-v1\.5/);
  }
});

test('ContinuityEngine receives engine config and rejects allowlist outsiders', async () => {
  const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-host-'));
  const pkgs = path.join(hostRoot, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai');
  fs.mkdirSync(path.join(pkgs, 'dsh-compaction-basic', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(pkgs, 'dsh-compaction', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pkgs, 'dsh-compaction-basic', 'lib', 'index.js'), 'export class BasicCompactionEngine { constructor(ctx){ this.ctx = ctx; } }\nexport default BasicCompactionEngine;\n');
  fs.writeFileSync(path.join(pkgs, 'dsh-compaction', 'lib', 'index.js'), 'export function toolPairingBalancedBefore(){return true}\nexport function toolPairingBalancedAfter(){return true}\n');
  const prior = process.resourcesPath;
  process.resourcesPath = hostRoot;
  try {
    const localHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-local-overlay-'));
    fs.mkdirSync(path.join(localHome, 'local'), { recursive: true });
    fs.writeFileSync(path.join(localHome, 'local', 'unified-fold.json'), JSON.stringify({
      enabled: true,
      sessionIds: ['session-local-a', 'session-local-b'],
      providerId: 'local-provider',
      model: 'local-model',
    }), 'utf8');
    const { ContinuityEngine } = await import('../src/engine.mjs?config-propagation');
    const llm = { stream: async function* () {} };
    const ctx = { systemPrompt: { section() {} }, get: (name) => name === 'llm' ? llm : (name === 'systemPrompt' ? { section() {} } : null) };
    const e = new ContinuityEngine(ctx, {
      compactionBasic: {},
      unifiedFold: {
        enabled: false,
        home: localHome,
        localConfig: './local/unified-fold.json',
        embeddingModel: './models/Xenova/bge-small-zh-v1.5',
      },
    });
    assert.equal(e.unifiedFold.enabled, true);
    assert.equal(e.unifiedFold.sessionIds.has('session-local-a'), true);
    assert.equal(e.unifiedFold.sessionIds.has('session-local-b'), true);
    assert.equal(e.unifiedFold.sessionIds.has('other-session'), false);
  } finally {
    process.resourcesPath = prior;
  }
});
