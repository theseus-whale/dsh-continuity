import fs from 'node:fs';
import path from 'node:path';

/** Read-only compatibility for a pre-existing Sonar v5 activation. */
export function readLegacySeed(root) {
  const activePath = path.join(root, 'active.json');
  if (!fs.existsSync(activePath)) return { present: false, readOnly: true };
  const active = JSON.parse(fs.readFileSync(activePath, 'utf8'));
  return { present: true, readOnly: true, active };
}

export function doesNotWriteLegacy(root) {
  return fs.existsSync(path.join(root, 'active.json')) ? false : true;
}
