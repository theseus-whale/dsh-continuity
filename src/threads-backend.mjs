/**
 * Forwarding seam between the thread tools and the isolated compaction engine.
 *
 * The engine lives inside the preset's `compaction` isolate; the tool row lives
 * at the preset root and cannot resolve that isolated service. The engine
 * registers its save implementation here, and the tool facade calls it. If the
 * engine row is absent (standard/band), `getThreadsBackend()` throws rather
 * than silently pretending a save happened.
 */

let backend = null;

export function setThreadsBackend(value) {
  backend = value;
}

export function getThreadsBackend() {
  if (backend === null) {
    throw new Error('continuity.save: the Continuity compaction engine is not mounted; no gist can be written');
  }
  return backend;
}

export function clearThreadsBackend(value) {
  if (backend === value) backend = null;
}
