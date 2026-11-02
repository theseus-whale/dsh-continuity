/**
 * Read-only facet panel snapshot for the host endpoint.
 * The UI works without this file; absence is reported as available:false.
 */
import fs from 'node:fs';
import path from 'node:path';

export const FACET_PANEL_FILE = 'facet-panel.json';

export function buildFacetState({ home = process.env.USERPROFILE ?? process.env.HOME } = {}) {
  const file = path.join(String(home ?? ''), '.dsh', 'continuity', FACET_PANEL_FILE);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { available: true, file, generatedAt: new Date().toISOString(), panel: raw };
  } catch (error) {
    return {
      available: false,
      file,
      generatedAt: new Date().toISOString(),
      reason: error?.code === 'ENOENT' ? 'missing' : String(error?.message ?? error),
    };
  }
}
