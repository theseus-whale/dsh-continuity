import fs from 'node:fs';
import { sha256 } from './config.mjs';

export function fileSha256(file) {
  return sha256(fs.readFileSync(file));
}

export function buildManifest({ config, files, extra = {} }) {
  const entries = Object.entries(files).map(([name, file]) => ({
    name,
    path: file,
    bytes: fs.statSync(file).size,
    sha256: fileSha256(file),
  }));
  return {
    kind: 'dsh-turn-ping-manifest-v1',
    version: config.version,
    enabled: config.enabled,
    mode: config.mode,
    config,
    files: entries,
    ...extra,
    generatedAt: new Date().toISOString(),
  };
}

export function verifyManifest(manifest) {
  const errors = [];
  for (const entry of manifest.files ?? []) {
    try {
      const actual = fileSha256(entry.path);
      if (actual !== entry.sha256) errors.push(`${entry.name}: SHA mismatch`);
      if (fs.statSync(entry.path).size !== entry.bytes) errors.push(`${entry.name}: bytes mismatch`);
    } catch (error) {
      errors.push(`${entry.name}: ${error.message}`);
    }
  }
  return { ok: errors.length === 0, errors };
}
