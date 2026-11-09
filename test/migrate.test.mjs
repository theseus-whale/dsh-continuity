import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateThreadsFile } from '../src/threads-store.mjs';

test('migrateThreadsFile normalizes old backfill rows on disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-continuity-migrate-'));
  const previous = process.env.DSH_CONTINUITY_HOME;
  process.env.DSH_CONTINUITY_HOME = dir;
  try {
    const state = {
      version: 1,
      sessions: {
        s1: {
          threads: [{
            id: 't',
            label: 'T',
            updatedAt: '2026-02-01T00:00:00.000Z',
            segments: [{
              fromSeq: 10,
              toSeq: 20,
              why: '历史回补 10..20',
              next: 'next',
              at: '2026-02-01T00:00:00.000Z',
              spanStart: '2025-12-31T00:00:00.000Z',
              spanEnd: '2025-12-31T00:10:00.000Z',
            }],
          }],
          activeId: 't',
          pending: null,
        },
      },
    };
    writeFileSync(join(dir, 'threads.json'), JSON.stringify(state), 'utf8');
    const result = await migrateThreadsFile();
    assert.equal(result.changed, 1);
    assert.match(result.backup, /threads\.json\.bak-normalize-/);
    const raw = JSON.parse(readFileSync(join(dir, 'threads.json'), 'utf8'));
    const thread = raw.sessions.s1.threads[0];
    const segment = thread.segments[0];
    assert.equal(segment.at, '2025-12-31T00:10:00.000Z');
    assert.equal(segment.archivedAt, '2026-02-01T00:00:00.000Z');
    assert.equal(thread.updatedAt, '2025-12-31T00:10:00.000Z');
  } finally {
    if (previous === undefined) delete process.env.DSH_CONTINUITY_HOME;
    else process.env.DSH_CONTINUITY_HOME = previous;
  }
});
