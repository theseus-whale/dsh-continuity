/**
 * Structural validation for cordis.patch.yml. Parses with the same `!!js`
 * scalar convention the Loader uses and checks the rows this plugin ships.
 *
 * Run with js-yaml on NODE_PATH (the DSH runtime provides it):
 *   $env:NODE_PATH = '<runtime>\node_modules'; node tools/check-patch.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const here = dirname(fileURLToPath(import.meta.url));
const patchPath = join(here, '..', 'cordis.patch.yml');

const jsType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (text) => ({ __jsExpr: text }),
});
const schema = yaml.DEFAULT_SCHEMA.extend([jsType]);
const document = yaml.load(readFileSync(patchPath, 'utf8'), { schema });

const problems = [];
if (!Array.isArray(document) || document.length !== 1 || !Array.isArray(document[0]?.insert)) {
  throw new Error('patch must be one top-level insert list');
}
const rows = document[0].insert;
const byId = new Map(rows.map((row) => [row.id, row]));
if (rows.length !== 3) problems.push(`expected 3 inserted rows, found ${rows.length}`);

const host = byId.get('dsh-continuity');
if (!host) problems.push('missing dsh-continuity host row');
else {
  if (host.name !== 'dsh-continuity') problems.push('host row name must be the package name');
  if (host.config?.panel?.path !== '/dsh-continuity/state.json') problems.push('host panel path mismatch');
}

function checkPlugins(presetId, expectedCompaction) {
  const row = byId.get(`preset-${presetId}`);
  if (!row) {
    problems.push(`missing preset-${presetId}`);
    return;
  }
  if (row.name !== '@deepseek-ai/dsh-agent-preset') problems.push(`${presetId}: wrong package name`);
  if (row.config?.id !== presetId) problems.push(`${presetId}: config.id mismatch`);
  const plugins = row.config?.plugins;
  if (!Array.isArray(plugins) || plugins.length === 0) {
    problems.push(`${presetId}: plugins missing`);
    return;
  }
  const ids = new Set();
  for (const plugin of plugins) {
    if (ids.has(plugin.id)) problems.push(`${presetId}: duplicate plugin id ${plugin.id}`);
    ids.add(plugin.id);
  }
  const group = plugins.find((plugin) => plugin.id === 'compaction');
  if (!group || group.group !== true) {
    problems.push(`${presetId}: missing compaction group`);
    return;
  }
  if (group.isolate?.compaction !== true) problems.push(`${presetId}: compaction realm not isolated`);
  const children = group.config ?? [];
  const engine = children.find((child) => child.id === expectedCompaction.id);
  if (!engine) {
    problems.push(`${presetId}: missing ${expectedCompaction.id}`);
    return;
  }
  if (engine.name !== expectedCompaction.name) {
    problems.push(`${presetId}: ${expectedCompaction.id} name is ${engine.name}`);
  }
  for (const [key, value] of Object.entries(expectedCompaction.config ?? {})) {
    if (JSON.stringify(engine.config?.[key]) !== JSON.stringify(value)) {
      problems.push(`${presetId}: ${expectedCompaction.id}.config.${key} mismatch`);
    }
  }
  const names = children.map((child) => child.id);
  for (const required of ['command-compact', 'tool-result-pruner']) {
    if (!names.includes(required)) problems.push(`${presetId}: compaction group lost ${required}`);
  }
  const tool = plugins.find((plugin) => plugin.id === 'session-log-tool');
  if (presetId === 'continuity') {
    if (tool === undefined) problems.push('continuity: missing session-log-tool');
    else if (tool.name !== 'dsh-continuity/session-log-tool') {
      problems.push(`continuity: session-log-tool name is ${tool.name}`);
    }
    const threads = plugins.find((plugin) => plugin.id === 'threads-tool');
    if (threads === undefined) problems.push('continuity: missing threads-tool');
    else if (threads.name !== 'dsh-continuity/threads-tool') {
      problems.push(`continuity: threads-tool name is ${threads.name}`);
    }
  } else {
    if (tool !== undefined) problems.push(`${presetId}: must not mount session-log-tool`);
    if (plugins.some((plugin) => plugin.id === 'threads-tool')) {
      problems.push(`${presetId}: must not mount threads-tool`);
    }
  }
  return plugins;
}

const band = checkPlugins('band', {
  id: 'compaction-basic',
  name: '@deepseek-ai/dsh-compaction-basic',
  config: { thresholdRatio: 0.92, retainRatio: 0.5 },
});
const continuity = checkPlugins('continuity', {
  id: 'continuity-engine',
  name: 'dsh-continuity/engine',
  config: {
    provenance: { header: true, standingConvention: true },
    compactionBasic: { thresholdRatio: 0.8, retainRatio: 0.5 },
  },
});

function shape(list) {
  return list
    .filter((plugin) => plugin.id !== 'session-log-tool' && plugin.id !== 'threads-tool')
    .map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      group: plugin.group === true,
      children: plugin.id === 'compaction'
        ? ['<engine>']
        : Array.isArray(plugin.config) && plugin.group === true ? shape(plugin.config) : undefined,
    }));
}

if (band && continuity) {
  const left = JSON.stringify(shape(band));
  const right = JSON.stringify(shape(continuity));
  if (left !== right) {
    problems.push('band and continuity presets differ outside the compaction child');
  }
}

if (problems.length > 0) {
  console.error('patch problems:');
  for (const problem of problems) console.error(` - ${problem}`);
  process.exitCode = 1;
} else {
  console.log(`patch ok: ${rows.length} rows; band presets ${band?.length} plugins; continuity ${continuity?.length} plugins`);
}
