/**
 * Plugin integrity manifest.
 *
 * Detects modifications to the installed plugin. Detection is not prevention;
 * the installed copy must also be read-only / ACL-protected.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SKIP_DIRS = new Set(['node_modules', '.git', '.npm-cache', 'test', 'tests', 'backups']);

function walk(root, current = root, out = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(root, path.join(current, entry.name), out);
    } else if (entry.isFile()) {
      out.push(path.relative(root, path.join(current, entry.name)).replace(/\\/g, '/'));
    }
  }
  return out;
}

export function snapshotPlugin(root) {
  const files = {};
  for (const relative of walk(root).sort()) {
    const full = path.join(root, relative);
    files[relative] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  }
  return { version: 1, algorithm: 'sha256', root: path.basename(root), files };
}

export function verifyPlugin(root, manifest) {
  const current = snapshotPlugin(root);
  const changed = [];
  const missing = [];
  const extra = [];
  for (const [file, hash] of Object.entries(manifest.files ?? {})) {
    if (!(file in current.files)) missing.push(file);
    else if (current.files[file] !== hash) changed.push(file);
  }
  for (const file of Object.keys(current.files)) {
    if (!(file in (manifest.files ?? {}))) extra.push(file);
  }
  return { ok: changed.length === 0 && missing.length === 0, changed, missing, extra };
}

export function readManifest(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeManifest(file, manifest) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2), 'utf8');
  return file;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, root, manifestFile] = process.argv.slice(2);
  if (command === 'snapshot' && root && manifestFile) {
    const manifest = snapshotPlugin(path.resolve(root));
    writeManifest(path.resolve(manifestFile), manifest);
    console.log(JSON.stringify({ ok: true, files: Object.keys(manifest.files).length }, null, 2));
  } else if (command === 'verify' && root && manifestFile) {
    const result = verifyPlugin(path.resolve(root), readManifest(path.resolve(manifestFile)));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } else {
    console.log('usage: plugin-integrity snapshot <root> <manifest> | verify <root> <manifest>');
    process.exitCode = 2;
  }
}
