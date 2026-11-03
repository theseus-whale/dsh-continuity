/**
 * Best-effort tool-layer path guard.
 *
 * This is not an OS security boundary: arbitrary code with full access can
 * still read/write files. It blocks the normal model tools from touching
 * another session's continuity directory.
 *
 * Design: only *path fields* are inspected. Message bodies, file contents and
 * source text are never scanned — editing a document that merely mentions the
 * continuity path must not be blocked.
 */
import fs from 'node:fs';
import path from 'node:path';
import { continuityRoot, isPersonaEnabled, resolvePersona, sessionDir } from './memory/persona.mjs';

const norm = (value) => String(value ?? '').replace(/\\/g, '/').toLowerCase();

/** Explicit operator allowlist. This is the only sanctioned cross-session path. */
function isOperatorSession(sessionId) {
  try {
    const file = path.join(continuityRoot(), 'operator-sessions.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(parsed) && parsed.map(String).includes(String(sessionId));
  } catch {
    return false;
  }
}

const ROOT_MARK = '.dsh/continuity';
const ROOT_TILDE = '~/.dsh/continuity';

/** Root-level diagnostic files are readable by any enabled persona. */
const SHARED_READ_FILES = new Set([
  norm(path.join(continuityRoot(), 'session-persona.json')),
  norm(path.join(continuityRoot(), 'operator-sessions.json')),
  norm(path.join(continuityRoot(), 'context-log.jsonl')),
]);

function isSharedIdentityRead(toolName, hits) {
  if (toolName !== 'read' || hits.length === 0) return false;
  return hits.every((hit) => SHARED_READ_FILES.has(norm(hit)));
}

/** Argument keys that actually carry a filesystem path. */
const PATH_KEYS = new Set([
  'file_path', 'path', 'cwd', 'dir', 'directory', 'target', 'destination', 'source', 'file',
]);

/** Argument keys that are prose or file bodies; never treated as paths. */
const TEXT_KEYS = new Set([
  'content', 'old_string', 'new_string', 'text', 'message', 'prompt', 'body',
  'summary', 'reason', 'note', 'query', 'pattern',
]);

/** Tools whose arguments are addressed to a human, not the filesystem. */
const MESSAGE_TOOLS = new Set(['send_message', 'peer_message', 'present']);

/** Shell tools: only the command string can name a path. */
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'shell', 'powershell']);

function isPathValue(value) {
  const n = norm(value);
  return n.includes(ROOT_MARK) || n.includes(ROOT_TILDE);
}

function collectPathValues(value, key = '', out = []) {
  if (typeof value === 'string') {
    if (PATH_KEYS.has(key) || key === '') out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathValues(item, key, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (TEXT_KEYS.has(k)) continue;
      collectPathValues(v, k, out);
    }
  }
  return out;
}

function targetPaths(toolName, args) {
  if (SHELL_TOOLS.has(toolName)) {
    return typeof args?.command === 'string' ? [args.command] : [];
  }
  return collectPathValues(args, 'file_path', []);
}

export function installSessionGuard(ctx) {
  if (!ctx || typeof ctx.inject !== 'function') return false;
  ctx.inject(['tools'], (scoped) => {
    if (!scoped?.tools || typeof scoped.tools.guard !== 'function') return;
    scoped.effect(() => scoped.tools.guard((exec) => {
      const sessionId = exec?.agent?.session?.id;
      if (sessionId === undefined || sessionId === null) return undefined;

      const toolName = String(exec?.name ?? '');
      if (MESSAGE_TOOLS.has(toolName)) return undefined;

      const hits = targetPaths(toolName, exec?.arguments ?? {}).filter(isPathValue);
      if (!hits.length) return undefined;

      // Reading the root identity map is explicitly part of the rules. It is
      // read-only and safe for any enabled persona; writes stay blocked.
      if (isSharedIdentityRead(toolName, hits)) return undefined;

      // An explicit operator may cross session boundaries even when the
      // operator's own persona is disabled. Keep this list small and auditable.
      if (isOperatorSession(sessionId)) return undefined;

      // Only paths under the continuity root reach the persona gate: a disabled
      // persona loses continuity access, not every tool.
      const personaId = resolvePersona(sessionId);
      if (!isPersonaEnabled(personaId)) return 'continuity: persona is disabled';

      const own = norm(sessionDir(sessionId));
      const ownForms = [
        own,
        norm('~/.dsh/continuity' + '/sessions/' + sessionId),
        norm('.dsh/continuity' + '/sessions/' + sessionId),
      ];
      for (const hit of hits) {
        let withoutOwn = norm(hit);
        for (const form of ownForms) withoutOwn = withoutOwn.split(form).join('');
        if (withoutOwn.includes(ROOT_MARK) || withoutOwn.includes(ROOT_TILDE)) {
          return "continuity: a session may not touch another session's continuity files";
        }
      }
      return undefined;
    }));
  });
  return true;
}

export default installSessionGuard;
