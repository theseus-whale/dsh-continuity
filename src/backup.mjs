/**
 * session 冷备份（本机复制）。供引擎每轮调用：距上次 ≥ intervalMs 才真正复制。
 *
 * 注意：会话文件正在被追加写，复制可能拿到残缺末帧——所以复制后校验帧，
 * 末帧解不开只记警告，不删备份。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function sessionFilePath({ home, sid }) {
  if (!home || !sid) return null;
  const root = path.join(home, '.dsh', 'sessions');
  if (!fs.existsSync(root)) return null;
  for (const dir of fs.readdirSync(root)) {
    const candidate = path.join(root, dir, sid, 'session.v4.jsonl.zstd');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function frameOffsets(buf) {
  const out = [];
  let pos = -1;
  while ((pos = buf.indexOf(MAGIC, pos + 1)) >= 0) out.push(pos);
  return out;
}

export function verifySessionFile(file) {
  const buf = fs.readFileSync(file);
  const offsets = frameOffsets(buf);
  if (offsets.length === 0) return { ok: false, reason: 'no-frame', bytes: buf.length };
  let decoded = 0;
  let textBytes = 0;
  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length;
    try {
      textBytes += zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8').length;
      decoded += 1;
    } catch { /* 末帧可能残缺 */ }
  }
  return { ok: decoded > 0, bytes: buf.length, frames: offsets.length, decodedFrames: decoded, textBytes };
}

/**
 * @returns {{skipped:true, reason:string} | {skipped:false, backup:string, check:object, removed:string[]}}
 */
export function maybeBackupSession({ home, sid, intervalMs = 15 * 60 * 1000, keep = 2, force = false, now = Date.now() } = {}) {
  const src = sessionFilePath({ home, sid });
  if (src === null) return { skipped: true, reason: 'no-session-file' };
  const stateFile = path.join(home, '.dsh', 'continuity', 'backup-state.json');
  let state = { lastAt: 0 };
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { state = { lastAt: 0 }; }
  if (!force && now - Number(state.lastAt ?? 0) < intervalMs) {
    return { skipped: true, reason: 'too-soon' };
  }
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', 'T');
  const destDir = path.join(home, '.dsh', 'archives', stamp);
  fs.mkdirSync(destDir, { recursive: true });
  const backup = path.join(destDir, 'session-' + String(sid).replace(/^session-/, '') + '.jsonl.zstd');
  fs.copyFileSync(src, backup);
  const check = verifySessionFile(backup);

  const root = path.join(home, '.dsh', 'archives');
  const mine = fs.readdirSync(root)
    .map((name) => ({ name, full: path.join(root, name) }))
    .filter((entry) => fs.existsSync(path.join(entry.full, 'session-' + String(sid).replace(/^session-/, '') + '.jsonl.zstd')))
    .sort((left, right) => (left.name < right.name ? 1 : -1));
  const removed = [];
  for (const entry of mine.slice(keep)) {
    fs.rmSync(entry.full, { recursive: true, force: true });
    removed.push(entry.name);
  }
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ lastAt: now, lastFile: backup, check }, null, 2), 'utf8');
  return { skipped: false, backup, check, removed };
}
