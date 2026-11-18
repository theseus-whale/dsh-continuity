import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadMergedIndex } from './storage.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const cache = new Map();

/** Cache keyed by the exact active-manifest bytes; pointer/delta change invalidates. */
export function loadActiveIndex(root, { fresh = false } = {}) {
  const activePath = path.join(root, 'active.json');
  if (!fs.existsSync(activePath)) return null;
  const bytes = fs.readFileSync(activePath);
  const manifestHash = sha(bytes);
  if (!fresh && cache.has(root) && cache.get(root).manifestHash === manifestHash) return cache.get(root);
  const active = JSON.parse(bytes.toString('utf8'));
  const merged = loadMergedIndex(root, active);
  const entry = { active, manifestHash, merged };
  cache.set(root, entry);
  return entry;
}

export function clearActiveCache(root) {
  if (root) cache.delete(root); else cache.clear();
}
