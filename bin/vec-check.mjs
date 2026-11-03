#!/usr/bin/env node
/**
 * Check whether the local embedding runtime produces a usable vector.
 *
 * Run from the installed package:
 *   node bin/vec-check.mjs
 */
import { embedTexts } from '../src/facets/embedding.mjs';

try {
  const [vector] = await embedTexts(['连续性记忆审计自检']);
  const dim = Array.isArray(vector) ? vector.length : 0;
  const finite = Array.isArray(vector) && vector.every((value) => Number.isFinite(value));
  console.log(JSON.stringify({
    ok: dim > 0 && finite,
    dimensions: dim,
    first3: Array.isArray(vector) ? vector.slice(0, 3) : [],
  }, null, 2));
  if (dim === 0 || !finite) process.exit(1);
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: String(error?.message ?? error),
    hint: 'run pnpm approve-builds, then pnpm rebuild onnxruntime-node sharp in the DSH profile',
  }, null, 2));
  process.exit(1);
}
