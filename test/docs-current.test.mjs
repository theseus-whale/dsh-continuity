import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const currentDocs = [
  'README.md', 'INSTALL.md', 'PANEL.md', 'RELEASE-NOTES.md',
  'docs/API-NOTES.md', 'docs/EXPERIMENT.md', 'docs/PORTABILITY.md',
  'docs/unified-fold.md', 'guides/README.md',
];

test('INSTALL has complete upgrade/apply/resume/verify flow and separate host credentials', () => {
  const text = fs.readFileSync(path.resolve('INSTALL.md'), 'utf8');
  for (const marker of ['migrate apply --plan', '--approve', 'migrate resume --plan', 'migrate verify --plan', 'Back up', 'allowLiveInjection', 'plan is NOT approval', 'ctx.llm', 'DSH_CONTINUITY_CREDENTIALS']) {
    assert.ok(text.includes(marker), `INSTALL missing ${marker}`);
  }
  assert.ok(text.includes('Index-only') && text.includes('Live natural cue'));
  assert.ok(text.includes('does **not** enable Host'));
});

test('public patch has current description, valid UTF-8, and preserved thresholds', () => {
  const text = fs.readFileSync(path.resolve('cordis.patch.yml'), 'utf8');
  assert.equal(/\uFFFD|閳|绾/.test(text), false, 'public patch contains mojibake');
  assert.equal(/Band-controlled|\bgist\b|A \/ B \/ C \/ K/i.test(text), false);
  assert.ok(text.includes('Unified fold with memory resonance'));
  for (const value of ['setpoint: 0.76', 'high: 0.76', 'low: 0.38', 'emergency: 0.85', 'emergencyTo: 0.62', 'protect: 0.20', 'maxPerBatch: 443843', 'minAction: 24000']) {
    assert.ok(text.includes(value), `public patch lost ${value}`);
  }
});

test('README names Node/host requirements without inventing a support matrix', () => {
  const text = fs.readFileSync(path.resolve('README.md'), 'utf8');
  assert.ok(text.includes('Node.js >=22'));
  assert.ok(text.includes('tested baseline'));
  assert.ok(text.includes('not a claim of support for every future Host'));
  assert.ok(text.includes('npm install <path-to-dsh-continuity-5.0.0-<hash>.tgz>'));
});

test('current docs describe current migration commands and no old architecture', () => {
  const forbidden = [/session_log/i, /\bgist\b/i, /\bBand\b/i, /\bABCK\b/i, /A \/ B \/ C \/ K/, /0\.2\.1-rc\.3/];
  const joined = currentDocs.map((file) => fs.readFileSync(path.resolve(file), 'utf8')).join('\n');
  for (const pattern of forbidden) assert.equal(pattern.test(joined), false, `current docs still contain ${pattern}`);
  for (const command of ['migrate audit', 'migrate plan', 'migrate apply', 'migrate resume', 'migrate verify']) {
    assert.ok(joined.includes(command), `current docs missing ${command}`);
  }
});

test('current docs contain no local user path or real session id', () => {
  const joined = currentDocs.map((file) => fs.readFileSync(path.resolve(file), 'utf8')).join('\n');
  assert.equal(/C:[\\/]Users[\\/]/i.test(joined), false);
  assert.equal(/session-6d313d34|session-0b094f6e/.test(joined), false);
});

test('panel restores waterline/projection without global fold history or provider actions', () => {
  const source = fs.readFileSync(path.resolve('client.js'), 'utf8');
  for (const marker of ['function BandBar(', 'function Projection(', 'data?.engine?.policy']) {
    assert.ok(source.includes(marker), `client missing ${marker}`);
  }
  assert.equal(source.includes("const STATE_URL = '/dsh-continuity/state.json'"), true);
  assert.equal(/fetch\(STATE_URL/.test(source), true);
  assert.equal(/createProvider|fetch\(['"]\/dsh-continuity\/(apply|verify)/.test(source), false);
});
