import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function appendDiagnostic(path, entry) {
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
  } catch {
    /* diagnostics must never change memory behavior */
  }
}
