#!/usr/bin/env node
import fs from 'node:fs';
import zlib from 'node:zlib';
import { buildRepairPlan, runRepair } from '../src/fullseed/repair.mjs';

function decode(file) {
  const buf = fs.readFileSync(file);
  if (!file.endsWith('.zstd')) return buf.toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  let pos = 0; let text = '';
  while (pos < buf.length) {
    const start = buf.indexOf(magic, pos); if (start < 0) break;
    const next = buf.indexOf(magic, start + 4); const end = next < 0 ? buf.length : next;
    text += zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8'); pos = end;
  }
  return text.split(/\r?\n/).filter(Boolean).map(JSON.parse);
}
function arg(name, fallback = null) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; }
const raw = arg('--raw'); const missing = arg('--missing'); const sessionId = arg('--session'); const root = arg('--root'); const oldIdentity = arg('--old-identity'); const oldCohorts = arg('--old-cohorts') ? arg('--old-cohorts').split(',').filter(Boolean) : null; const repairIdentity = arg('--repair-identity');
const checkpoint = Number(arg('--checkpoint', 'Infinity')); const initialCalls = Number(arg('--initial-calls', '4287')); const maxCalls = Number(arg('--max-calls', '56')); const globalCap = Number(arg('--global-cap', '7802'));
if (!raw || !missing || !sessionId || !root || (!oldIdentity && !oldCohorts) || !repairIdentity) { console.error('usage: fullseed-repair --raw <f> --missing <json> --session <id> --root <fullseed root> --old-identity <id> --repair-identity <id> [--dryrun|--approve --expected-missing 60 --max-calls 120 --provider-module <f>]'); process.exit(2); }
const events = decode(raw);
const plan = buildRepairPlan({ events, sessionId, checkpointSeq: checkpoint, missingPath: missing, oldIdentity, oldCohorts, repairIdentity, root, maxProviderCalls: globalCap, initialCalls });
if (!process.argv.includes('--approve')) {
  const dry = await runRepair({ plan, dryRun: true, initialCalls, maxProviderCalls: globalCap, repairMaxCalls: maxCalls });
  console.log(JSON.stringify({ ...dry, raw, missingPath: missing, root, checkpoint, repairMaxCalls: maxCalls, globalCap }, null, 2));
} else {
  const expected = Number(arg('--expected-missing')); const modulePath = arg('--provider-module');
  if (!modulePath) throw new Error('--provider-module required');
  const { pathToFileURL } = await import('node:url');
  const mod = await import(modulePath.startsWith('file:') ? modulePath : pathToFileURL(modulePath).href);
  const { provider, embedder } = await mod.createProvider();
  const result = await runRepair({ plan, provider, embedder, root, repairIdentity, dryRun: false, initialCalls, maxProviderCalls: globalCap, repairMaxCalls: maxCalls, approve: true, expectedMissing: expected });
  console.log(JSON.stringify(result, null, 2));
}
