/**
 * Persona namespace: vocabulary/rules/habits are persona-level, while index,
 * audit state, and hints stay session-level.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = () => process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();

export function continuityRoot(home = HOME()) {
  return path.join(home, '.dsh', 'continuity');
}

export function sessionPersonaPath(home = HOME()) {
  return path.join(continuityRoot(home), 'session-persona.json');
}

export function personaDir(personaId, home = HOME()) {
  return path.join(continuityRoot(home), 'personas', String(personaId || 'default'));
}

export function sessionDir(sessionId, home = HOME()) {
  return path.join(continuityRoot(home), 'sessions', String(sessionId));
}

export function sessionFile(sessionId, name, home = HOME()) {
  return path.join(sessionDir(sessionId, home), name);
}

/** Session vocabulary is the source of truth; no persona/global fallback. */
export function resolveSessionVocabFile(sessionId, name, home = HOME()) {
  return sessionFile(sessionId, name, home);
}

export function loadSessionPersonas(home = HOME()) {
  try {
    const raw = fs.readFileSync(sessionPersonaPath(home), 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function resolvePersona(sessionId, home = HOME()) {
  const map = loadSessionPersonas(home);
  if (sessionId && typeof map[String(sessionId)] === 'string' && map[String(sessionId)]) {
    return map[String(sessionId)];
  }
  if (typeof map.default === 'string' && map.default) return map.default;
  return 'continuity';
}

export function personaFile(personaId, name, home = HOME()) {
  return path.join(personaDir(personaId, home), name);
}

/** Per-persona enable switch; continuity stays enabled for old installs. */
export function isPersonaEnabled(personaId, home = HOME()) {
  const id = String(personaId || 'default');
  const file = personaFile(id, 'persona.json', home);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return parsed?.enabled !== false;
  } catch {
    return id === 'continuity';
  }
}

/** Persona files win; only continuity may fall back to the archived global table. */
export function resolveVocabFile(personaId, name, home = HOME(), { allowLegacy = personaId === 'continuity' } = {}) {
  const primary = personaFile(personaId, name, home);
  if (fs.existsSync(primary)) return primary;
  if (!allowLegacy) return primary;
  const legacy = path.join(continuityRoot(home), name);
  return fs.existsSync(legacy) ? legacy : primary;
}
