import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { auditSession } from './audit.mjs';
import { buildIdentity } from '../fullseed/seed.mjs';
import { readRootCalls } from '../fullseed/repair.mjs';
import { PROMPT_TEXT_SHA256, EXTRACTION_RULE_SHA256 } from '../fullseed/summary.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');

export function planMigration({ dshHome, sessionId, out = null }) {
  if (!sessionId) throw new Error('plan: --session required');
  const audit = auditSession({ dshHome, sessionId });
  if (!audit.raw?.readable) throw new Error(`plan: raw not readable: ${audit.raw?.error ?? 'unknown'}`);
  if (!audit.canPlan) throw new Error('plan: canonical chunks failed verification');
  const checkpoint = audit.raw.checkpoint;
  if (!Number.isInteger(checkpoint) || checkpoint <= 0) throw new Error('plan: finite checkpoint required');
  const identity = buildIdentity({ promptTextSha256: PROMPT_TEXT_SHA256, extractionRuleSha256: EXTRACTION_RULE_SHA256 });
  const storageRoot = path.join(dshHome, 'continuity', 'sessions', String(sessionId), 'turn-ping', 'fullseed');
  const rootCounter = readRootCalls(storageRoot);
  const rootInitialCalls = rootCounter?.calls ?? 0;
  const expected = audit.missing;
  const maxCalls = expected * 2;
  const plan = {
    schemaVersion: 1,
    contractVersion: 'continuity-migration-plan-v1',
    createdAt: new Date().toISOString(),
    sessionId: String(sessionId),
    raw: {
      path: audit.raw.path,
      bytes: audit.raw.bytes,
      sha256: sha(fs.readFileSync(audit.raw.path)),
      events: audit.raw.events,
      lastSeq: audit.raw.lastSeq,
    },
    checkpoint,
    chunkSet: {
      count: audit.chunks.count,
      sha256: audit.chunks.sha256,
      first: audit.chunks.first,
      last: audit.chunks.last,
    },
    cohorts: [
      { id: 'legacy', counts: audit.existing.legacy, reusable: 0 },
      { id: 'fullseed', counts: audit.existing.fullseed, reusable: audit.reusable },
    ],
    storageRoot,
    reusable: audit.reusable,
    missing: audit.missing,
    reusableItems: audit.reusableItems,
    missingItems: audit.missingItems,
    budget: {
      expectedProviderCalls: expected,
      maxProviderCalls: rootInitialCalls + maxCalls,
      embeddingCalls: expected,
      rootInitialCalls,
      rootCounterPath: path.join(storageRoot, 'provider-calls-root.json'),
      remainingProviderCalls: maxCalls,
    },
    identity,
    active: audit.active,
    issues: audit.issues,
    status: 'plan-only-no-apply',
  };
  const content = JSON.stringify(plan);
  plan.contentSha256 = sha(content);
  const dir = out ? path.dirname(path.resolve(out)) : path.join(dshHome, 'continuity', 'sessions', String(sessionId), 'migration');
  fs.mkdirSync(dir, { recursive: true });
  const file = out ? path.resolve(out) : path.join(dir, `plan-${plan.contentSha256.slice(0, 16)}.json`);
  if (fs.existsSync(file)) throw new Error(`plan: refusing to overwrite ${file}`);
  fs.writeFileSync(file, JSON.stringify(plan, null, 2) + '\n', 'utf8');
  return { plan, file, fileSha256: sha(fs.readFileSync(file)) };
}
