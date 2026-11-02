/**
 * Tail TAG-repeat counting.
 *
 * Count is per T only: a valid `TAG: T` while T is active increments that T's
 * counter. Switching T does not touch the old T; the new T starts at its own
 * count. No header prompt and no cache stamp exist here.
 */

export const RECHECK_FIRST_TAGS = 100;
export const RECHECK_INTERVAL_TAGS = 40;

export function emptyRecheckState() {
  return { version: 1, threads: {} };
}

export function normalizeRecheckState(raw) {
  if (raw === null || typeof raw !== 'object') return emptyRecheckState();
  if (raw.threads === null || typeof raw.threads !== 'object') return emptyRecheckState();
  return { version: 1, threads: { ...raw.threads } };
}

function entryOf(state, threadId) {
  const key = String(threadId ?? '');
  const entry = state.threads[key];
  if (entry === null || typeof entry !== 'object') {
    return { key, entry: { count: 0, asked: 0, lastAskedAt: 0 } };
  }
  return {
    key,
    entry: {
      count: Number(entry.count ?? 0),
      asked: Number(entry.asked ?? 0),
      lastAskedAt: Number(entry.lastAskedAt ?? 0),
    },
  };
}

/** Increment one accepted same-T TAG and say whether the threshold is due. */
export function bumpTagCount(raw, { threadId } = {}) {
  const state = normalizeRecheckState(raw);
  const { key, entry } = entryOf(state, threadId);
  entry.count += 1;
  const due = entry.count >= RECHECK_FIRST_TAGS
    && (entry.lastAskedAt === 0 || entry.count - entry.lastAskedAt >= RECHECK_INTERVAL_TAGS);
  if (due) {
    entry.asked += 1;
    entry.lastAskedAt = entry.count;
  }
  state.threads[key] = entry;
  return { state, due, entry };
}

/** y means "still this T": reset this T's repeat count. */
export function resetTagCount(raw, { threadId } = {}) {
  const state = normalizeRecheckState(raw);
  const { key, entry } = entryOf(state, threadId);
  entry.count = 0;
  entry.lastAskedAt = 0;
  state.threads[key] = entry;
  return { state, entry };
}

/**
 * The answer line is `[闸·回查] y` / `[闸·回查] n` (old `[回查]` accepted),
 * or a bare y/n as the final non-empty line. A following TAG line is allowed,
 * so look one line back. Prose containing y/n is not accepted.
 */
export function parseRecheckAnswer(text) {
  const lines = String(text ?? '').trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const answerOf = (line) => {
    const tagged = /^\[(?:闸·)?回查\]\s*(y|n)$/i.exec(line);
    if (tagged !== null) return tagged[1].toLowerCase() === 'y' ? 'yes' : 'no';
    if (/^y$/i.test(line)) return 'yes';
    if (/^n$/i.test(line)) return 'no';
    return null;
  };
  const last = lines.length > 0 ? lines[lines.length - 1] : '';
  const direct = answerOf(last);
  if (direct !== null) return direct;
  if (/^TAG\s*[:：]/i.test(last) && lines.length > 1) return answerOf(lines[lines.length - 2]);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const found = answerOf(lines[index]);
    if (found !== null) return found;
  }
  return null;
}

export function recheckRetryText(alias) {
  return '回查：没有读到 y 或 n。\n'
    + '本轮最后先写一行：\n'
    + '[闸·回查] y — 仍在 ' + String(alias ?? '当前 T') + '\n'
    + '[闸·回查] n — 已离开（然后正常写 TAG 新线）\n'
    + '连续 3 次没有 y/n 会按 y 放行，不会困住你。';
}

export function recheckAutoText(alias) {
  return '回查：连续 3 次没有读到 y/n；这是故意按 y 放行的，不会因此困住你。\n'
    + '请正常写 TAG 收尾。';
}
