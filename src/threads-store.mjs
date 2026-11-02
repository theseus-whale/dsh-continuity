/**
 * Durable Continuity thread state, partitioned by session.
 *
 * The session log remains the source of truth for what the model saw; this
 * file only stores the thread index and the active pointer. Rules/habits are
 * read per session and seeded from the plugin's root templates.
 *
 * Defaults: ~/.dsh/continuity/threads.json and
 * ~/.dsh/continuity/sessions/<id>/{rules,habits}.md.
 * DSH_CONTINUITY_HOME overrides the directory for tests and isolated profiles.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, copyFile, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { normalizeThread } from './threads.mjs';

let writeQueue = Promise.resolve();

export function continuityHome() {
  const override = process.env.DSH_CONTINUITY_HOME;
  return override !== undefined && override.length > 0
    ? override
    : join(homedir(), '.dsh', 'continuity');
}

export function threadsFile() {
  return join(continuityHome(), 'threads.json');
}

export function rulesFile(sessionId = null) {
  return sessionId === null ? join(continuityHome(), 'rules.md') : join(continuityHome(), 'sessions', String(sessionId), 'rules.md');
}

export function habitsFile(sessionId = null) {
  return sessionId === null ? join(continuityHome(), 'habits.md') : join(continuityHome(), 'sessions', String(sessionId), 'habits.md');
}

function templateFile(name) {
  return fileURLToPath(new URL(`../templates/${name}`, import.meta.url));
}

/** Seed a session's rules/habits from the plugin root template, never from another session. */
async function ensureSessionFile(sessionId, name) {
  const target = name === 'rules.md' ? rulesFile(sessionId) : habitsFile(sessionId);
  try {
    await readFile(target, 'utf8');
    return target;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(join(continuityHome(), 'sessions', String(sessionId)), { recursive: true });
  try {
    const source = templateFile(name);
    await copyFile(source, target);
  } catch {
    await writeFile(target, '', 'utf8');
  }
  return target;
}

/** Read the whole state file; a missing file is an empty state, never an error. */
export async function readState() {
  try {
    const raw = await readFile(threadsFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('threads.json must contain an object');
    }
    return {
      version: 1,
      sessions: parsed.sessions !== null && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)
        ? parsed.sessions
        : {},
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, sessions: {} };
    throw new Error(`continuity: cannot read ${threadsFile()}: ${error?.message ?? error}`);
  }
}

async function writeState(state) {
  const dir = continuityHome();
  await mkdir(dir, { recursive: true });
  const file = threadsFile();
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temp, file);
  } catch (error) {
    try { await unlink(temp); } catch { /* best effort */ }
    throw new Error(`continuity: cannot write ${file}: ${error?.message ?? error}`);
  }
}

/** One session's state, or an empty shell. */
export async function getSession(sessionId) {
  const id = String(sessionId);
  const state = await readState();
  const session = state.sessions[id];
  if (session === null || session === undefined || typeof session !== 'object') {
    return { threads: [], activeId: null, pending: null };
  }
  return {
    threads: Array.isArray(session.threads) ? session.threads.map((thread) => normalizeThread(thread)) : [],
    activeId: typeof session.activeId === 'string' ? session.activeId : null,
    pending: session.pending !== null && typeof session.pending === 'object' && !Array.isArray(session.pending)
      ? session.pending
      : null,
  };
}

/**
 * Serialize a read-modify-write against one session. `mutate` receives a deep
 * copy and returns the next session (or mutates and returns undefined).
 */
export async function updateSession(sessionId, mutate) {
  const id = String(sessionId);
  const operation = writeQueue.then(async () => {
    const state = await readState();
    const current = state.sessions[id];
    const base = current !== null && current !== undefined && typeof current === 'object'
      ? {
        threads: Array.isArray(current.threads) ? current.threads.map((thread) => normalizeThread(thread)) : [],
        activeId: typeof current.activeId === 'string' ? current.activeId : null,
        pending: current.pending !== null && typeof current.pending === 'object' && !Array.isArray(current.pending)
          ? current.pending
          : null,
      }
      : { threads: [], activeId: null, pending: null };
    const working = structuredClone(base);
    const next = await mutate(working);
    const value = next !== null && next !== undefined && typeof next === 'object' ? next : working;
    state.sessions[id] = {
      threads: Array.isArray(value.threads) ? value.threads.map((thread) => normalizeThread(thread)) : [],
      activeId: typeof value.activeId === 'string' ? value.activeId : null,
      pending: value.pending !== null && typeof value.pending === 'object' && !Array.isArray(value.pending)
        ? value.pending
        : null,
      updatedAt: new Date().toISOString(),
    };
    await writeState(state);
    return state.sessions[id];
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

/**
 * One-shot read-time normalization migration. Older backfill rows stored the
 * write moment in `at`; normalize them on disk too, so direct threads.json
 * consumers see the same content time as the plugin.
 */
export async function migrateThreadsFile({ log = null } = {}) {
  const state = await readState();
  const changes = [];
  for (const [sessionId, session] of Object.entries(state.sessions)) {
    if (!Array.isArray(session?.threads) || session.threads.length === 0) continue;
    const normalized = session.threads.map((thread) => normalizeThread(thread));
    if (JSON.stringify(normalized) !== JSON.stringify(session.threads)) {
      changes.push({ sessionId, normalized });
    }
  }
  if (changes.length === 0) return { changed: 0, backup: null };

  const file = threadsFile();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${file}.bak-normalize-${stamp}`;
  try { await copyFile(file, backup); } catch { /* a backup failure must not block normalization */ }

  for (const change of changes) {
    await updateSession(change.sessionId, (current) => {
      current.threads = change.normalized;
      return current;
    });
  }
  try { log?.info?.(`[dsh-continuity] normalized ${changes.length} session(s) on disk; backup=${backup}`); } catch { /* logging only */ }
  return { changed: changes.length, backup };
}

/**
 * Read the user's rules file verbatim. It is optional and has no default
 * content; the plugin never creates or writes it.
 * @returns {Promise<{ text: string, missing: boolean, path: string }>}
 */
export async function readRules(sessionId = null) {
  const path = sessionId === null ? rulesFile() : await ensureSessionFile(sessionId, 'rules.md');
  try {
    const text = await readFile(path, 'utf8');
    return { text, missing: false, path };
  } catch (error) {
    if (error?.code === 'ENOENT') return { text: '', missing: true, path };
    throw new Error(`continuity: cannot read ${path}: ${error?.message ?? error}`);
  }
}

/** Soft preferences: optional, same read-only contract as rules. */
export async function readHabits(sessionId = null) {
  const path = sessionId === null ? habitsFile() : await ensureSessionFile(sessionId, 'habits.md');
  try {
    const text = await readFile(path, 'utf8');
    return { text, missing: false, path };
  } catch (error) {
    if (error?.code === 'ENOENT') return { text: '', missing: true, path };
    throw new Error(`continuity: cannot read ${path}: ${error?.message ?? error}`);
  }
}
