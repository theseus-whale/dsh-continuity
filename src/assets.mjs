import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const MIME_EXT = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'application/pdf': '.pdf',
  'application/json': '.json',
  'text/plain': '.txt',
});

function safeId(value, fallback) {
  const text = String(value ?? '').replace(/[^a-zA-Z0-9._-]/g, '');
  return text.length > 0 ? text.slice(0, 160) : fallback;
}

function safeName(value, fallback = 'asset.bin') {
  const text = path.basename(String(value ?? '').replaceAll('\\', '/')).replace(/[^a-zA-Z0-9._ -]/g, '');
  return text.length > 0 ? text.slice(0, 160) : fallback;
}

function decodeDataUrl(value) {
  const text = String(value ?? '');
  const marker = text.indexOf(',');
  if (!text.startsWith('data:') || marker < 0) return null;
  const header = text.slice(5, marker);
  const payload = text.slice(marker + 1);
  const isBase64 = /;base64(?:;|$)/i.test(header);
  const mime = header.split(';')[0] || null;
  return {
    buffer: Buffer.from(payload, isBase64 ? 'base64' : 'utf8'),
    mime,
  };
}

/**
 * Return a local payload for a non-text content block, without fetching URLs.
 * @returns {{ buffer: Buffer, sourcePath: string|null, mime: string|null }|null}
 */
export function blockPayload(block) {
  if (block === null || typeof block !== 'object') return null;
  const mime = block.mimeType ?? block.mime ?? block.attachment?.mimeType
    ?? block.attachment?.mime ?? block.source?.media_type ?? null;
  const raw = block.source?.data ?? block.data ?? block.base64;
  if (typeof raw === 'string' && raw.length > 0) {
    const decoded = decodeDataUrl(raw);
    if (decoded !== null) return { ...decoded, sourcePath: null, mime: mime ?? decoded.mime };
    try {
      const buffer = Buffer.from(raw, 'base64');
      if (buffer.length > 0) return { buffer, sourcePath: null, mime };
    } catch { /* fall through */ }
  }
  const sourcePath = block.attachment?.path ?? block.path ?? block.source?.path;
  if (typeof sourcePath === 'string' && sourcePath.length > 0 && fs.existsSync(sourcePath)) {
    return { buffer: fs.readFileSync(sourcePath), sourcePath, mime };
  }
  return null;
}

export function assetKind(block) {
  return typeof block?.type === 'string' ? block.type : 'file';
}

export function blockMeta(block) {
  const kind = assetKind(block);
  const payload = blockPayload(block);
  const name = safeName(
    block?.attachment?.name ?? block?.name ?? block?.fileName ?? block?.source?.name,
    `${kind}-asset`,
  );
  const size = block?.attachment?.size ?? block?.size ?? block?.bytes;
  return {
    kind,
    name,
    mime: payload?.mime ?? block?.mimeType ?? block?.mime ?? null,
    bytes: Number.isFinite(size) ? size : (payload?.buffer.length ?? null),
    sourcePath: payload?.sourcePath ?? null,
  };
}

export function sessionAssetsDir(home, sessionId) {
  return path.join(home, 'sessions', safeId(sessionId, 'unknown'), 'assets');
}

export function assetRelativePath({ kind, seq, sha256, mime, sourcePath, name, prefix = 'parent' }) {
  const ext = MIME_EXT[mime] ?? (path.extname(sourcePath ?? name ?? '') || '.bin');
  return path.posix.join(
    prefix,
    `${safeId(kind, 'asset')}-${safeId(seq, '0')}-${String(sha256).slice(0, 8)}${ext}`,
  );
}

/**
 * Write one block payload under the parent session assets and append one index
 * row. The write is atomic; an existing hash-named file is reused.
 */
export async function writeAsset({
  home,
  sessionId,
  block,
  seq,
  owner = 'parent',
  childSessionId = null,
  runId = null,
  prefix = 'parent',
}) {
  const payload = blockPayload(block);
  if (payload === null) {
    return { ok: false, reason: 'no-payload', meta: blockMeta(block) };
  }
  const meta = blockMeta(block);
  const sha256 = createHash('sha256').update(payload.buffer).digest('hex');
  const relative = assetRelativePath({
    kind: meta.kind,
    seq,
    sha256,
    mime: meta.mime,
    sourcePath: meta.sourcePath,
    name: meta.name,
    prefix,
  });
  const directory = sessionAssetsDir(home, sessionId);
  const absolute = path.join(directory, relative);
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  if (!fs.existsSync(absolute)) {
    const temporary = `${absolute}.${randomUUID()}.tmp`;
    await fsp.writeFile(temporary, payload.buffer, { flag: 'wx' });
    await fsp.rename(temporary, absolute);
  }
  const row = {
    owner,
    sessionId: String(sessionId),
    childSessionId: childSessionId === null ? null : String(childSessionId),
    runId: runId === null ? null : String(runId),
    seq: Number(seq),
    kind: meta.kind,
    mime: meta.mime,
    name: meta.name,
    bytes: payload.buffer.length,
    sha256,
    path: path.posix.join('assets', relative),
    at: new Date().toISOString(),
  };
  const indexPath = path.join(directory, 'index.jsonl');
  const existingRows = await readAssetIndex({ home, sessionId });
  const existing = existingRows.find((entry) => entry.seq === Number(seq)
    && entry.sha256 === sha256
    && entry.path === row.path);
  if (existing !== undefined) {
    return { ok: true, row: existing, relative, absolute };
  }
  await fsp.appendFile(indexPath, `${JSON.stringify(row)}\n`, 'utf8');
  return { ok: true, row, relative, absolute };
}

/** Mirror a child/PTC payload under the parent session's ptc/ namespace. */
export async function writeChildAsset({
  home,
  parentSessionId,
  childSessionId,
  runId,
  block,
  seq,
}) {
  const prefix = path.posix.join(
    'ptc',
    safeId(runId, 'run'),
    safeId(childSessionId, 'child'),
  );
  return writeAsset({
    home,
    sessionId: parentSessionId,
    block,
    seq,
    owner: 'child',
    childSessionId,
    runId,
    prefix,
  });
}

export async function readAssetIndex({ home, sessionId }) {
  const file = path.join(sessionAssetsDir(home, sessionId), 'index.jsonl');
  try {
    const text = await fsp.readFile(file, 'utf8');
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function findAssetBySeq({ home, sessionId, seq }) {
  const rows = await readAssetIndex({ home, sessionId });
  return rows.filter((row) => Number(row.seq) === Number(seq));
}

export function assetMarker(row, source = 'parent') {
  if (source === 'child') {
    return `[asset-child session=${row.childSessionId ?? row.sessionId} run=${row.runId ?? '?'}`
      + ` seq=${row.seq} mime=${row.mime ?? '?'} bytes=${row.bytes ?? '?'} path=${row.path}]`;
  }
  return `[asset-parent seq=${row.seq} mime=${row.mime ?? '?'}`
    + ` bytes=${row.bytes ?? '?'} path=${row.path}]`;
}
