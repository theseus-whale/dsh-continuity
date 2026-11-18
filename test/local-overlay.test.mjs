import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveUnifiedFoldConfig } from '../src/fold/unified-config.mjs';

const publicConfig = { enabled: false, localConfig: './local/unified-fold.json', embeddingModel: './models/Xeno' };

test('public disabled config plus missing local overlay stays disabled', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'uf-public-'));
  assert.equal(resolveUnifiedFoldConfig(publicConfig, { home }), null);
});

test('local overlay enables only listed sessions and supplies provider routing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'uf-local-'));
  fs.mkdirSync(path.join(home, 'local'), { recursive: true });
  fs.writeFileSync(path.join(home, 'local', 'unified-fold.json'), JSON.stringify({
    enabled: true,
    sessionIds: ['session-local-a', 'session-local-a', 'session-local-b'],
    providerId: 'local-provider',
    model: 'local-model',
  }), 'utf8');
  const resolved = resolveUnifiedFoldConfig(publicConfig, { home });
  assert.ok(resolved);
  assert.equal(resolved.enabled, true);
  assert.deepEqual([...resolved.sessionIds].sort(), ['session-local-a', 'session-local-b']);
  assert.equal(resolved.providerId, 'local-provider');
  assert.equal(resolved.model, 'local-model');
});

test('local overlay without sessionIds fails closed; explicit empty denies all', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'uf-invalid-'));
  fs.mkdirSync(path.join(home, 'local'), { recursive: true });
  const file = path.join(home, 'local', 'unified-fold.json');
  fs.writeFileSync(file, JSON.stringify({ enabled: true }), 'utf8');
  assert.throws(() => resolveUnifiedFoldConfig(publicConfig, { home }), /must specify sessionIds/);
  fs.writeFileSync(file, JSON.stringify({ enabled: true, sessionIds: [] }), 'utf8');
  assert.equal(resolveUnifiedFoldConfig(publicConfig, { home }), null);
  fs.writeFileSync(file, '{not json', 'utf8');
  assert.throws(() => resolveUnifiedFoldConfig(publicConfig, { home }));
});
