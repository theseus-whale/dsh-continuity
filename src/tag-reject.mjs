/**
 * One-shot display state for a rejected TAG.
 *
 * The first pre-step that sees a rejection renders it and writes `shown:true`;
 * the next pre-step removes the file without rendering again. A second rejection
 * for the same turn does not reset `shown`, so one turn cannot spam the header.
 */
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

export const TAG_REJECT_FILE = 'tag-reject.json';

function read(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Record the rejection, preserving an existing display for the same turn. */
export function recordTagReject({ file, turn, token, kind, reason, now = Date.now() }) {
  const previous = read(file);
  const sameTurnShown = previous !== null && Number(previous.turn) === Number(turn) && previous.shown === true;
  const next = {
    at: new Date(now).toISOString(),
    turn,
    token,
    kind,
    reason,
    shown: sameTurnShown,
  };
  if (sameTurnShown) next.shownAt = previous.shownAt ?? previous.at ?? null;
  writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** The exact header format the instance already reads. */
export function renderTagRejectHeader(reject) {
  return '\n[打标·退回] 第 ' + String(reject.turn ?? '?') + ' 轮没有记下标签：你写的是「' + String(reject.token ?? '?') + '」——'
    + String(reject.reason ?? reject.kind ?? '被拒') + '。'
    + '\n  修法：node ~/.dsh/continuity/turnmap.mjs set --turn ' + String(reject.turn ?? '?') + ' --tag <Tx>'
    + '（写别名，或写一个表里没有的新词；引号里的词按字面处理）';
}

/**
 * Render at most once, then delete on the following consumption.
 * If the rejected turn already has a tag, the notice is stale: delete without
 * rendering. Returns `{action:'none'|'shown'|'deleted', text, reject?, reason?}`.
 */
export function consumeTagReject({ file, isResolved = () => false, now = Date.now() }) {
  const reject = read(file);
  if (reject === null) {
    try { unlinkSync(file); } catch { /* nothing to remove */ }
    return { action: 'none', text: '' };
  }
  if (isResolved(Number(reject.turn))) {
    try { unlinkSync(file); } catch { /* next pre-step retries */ }
    return { action: 'deleted', text: '', reason: 'resolved' };
  }
  if (reject.shown === true) {
    try { unlinkSync(file); } catch { /* next pre-step retries */ }
    return { action: 'deleted', text: '' };
  }
  const text = renderTagRejectHeader(reject);
  const next = {
    ...reject,
    shown: true,
    shownAt: new Date(now).toISOString(),
  };
  try { writeFileSync(file, JSON.stringify(next, null, 2), 'utf8'); } catch { /* display still valid */ }
  return { action: 'shown', text, reject: next };
}
