/**
 * save 预检（纯函数）：把“我每次 save 前要手查的几件事”合成一次计算。
 *
 * 输入：会话事件 + 轮标签行 + 要折叠的 seq 区间
 * 输出：
 *   turns            区间内出现过的轮
 *   untaggedTurns    区间内没有轮标签的轮
 *   tagCounts        每个标签覆盖多少条消息（用于判断“这一折是不是混了几件事”）
 *   plan             按标签切分后的建议段（只有 >1 个标签时才有意义）
 *   t0Candidates     区间内“没有标签且用户文本够长”的轮（新事物候选，最多 5 条）
 */
import { visibleText } from './t0.mjs';

export function buildPreflight({ events = [], turnTagRows = [], fromSeq = 0, toSeq = 0, maxCandidates = 5 } = {}) {
  // 没传区间时（save 不带 fromSeq/toSeq），不能把 toSeq 当 0 —— 那会把所有事件都过滤掉。
  const effectiveTo = Number.isFinite(toSeq) && toSeq > 0 ? toSeq : Infinity;
  const tagged = new Map();
  for (const row of Array.isArray(turnTagRows) ? turnTagRows : []) {
    const turn = Number(row?.turn);
    if (Number.isInteger(turn)) tagged.set(turn, String(row?.tag ?? ''));
  }

  const turnSeqs = new Map();
  const userText = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const seq = Number(event?.seq);
    if (!Number.isInteger(seq) || seq < fromSeq || seq > effectiveTo) continue;
    if (event?.type !== 'user/message' && event?.type !== 'assistant/message') continue;
    const turn = Number(event?.data?.turn);
    if (!Number.isInteger(turn)) continue;
    const bucket = turnSeqs.get(turn) ?? [];
    bucket.push(seq);
    turnSeqs.set(turn, bucket);
    if (event.type === 'user/message') {
      const text = visibleText(event).replace(/\s+/g, ' ').trim();
      if (text.length > 0) userText.set(turn, text);
    }
  }

  const turns = [...turnSeqs.keys()].sort((a, b) => a - b);
  const untaggedTurns = turns.filter((turn) => !tagged.has(turn) || tagged.get(turn) === '');

  const tagCounts = new Map();
  const planMap = new Map();
  for (const turn of turns) {
    const tag = tagged.get(turn) ?? '(无)';
    const count = turnSeqs.get(turn).length;
    tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + count);
    const seqs = turnSeqs.get(turn);
    const entry = planMap.get(tag) ?? { tag, from: Math.min(...seqs), to: Math.max(...seqs), count: 0, turns: 0 };
    entry.from = Math.min(entry.from, ...seqs);
    entry.to = Math.max(entry.to, ...seqs);
    entry.count += count;
    entry.turns += 1;
    planMap.set(tag, entry);
  }

  const plan = [...planMap.values()].sort((a, b) => a.from - b.from);
  const t0Candidates = turns
    .filter((turn) => untaggedTurns.includes(turn) && (userText.get(turn) ?? '').length >= 20)
    .slice(0, maxCandidates)
    .map((turn) => ({ turn, seq: Math.min(...turnSeqs.get(turn)), head: (userText.get(turn) ?? '').slice(0, 60) }));

  return {
    turns: turns.length,
    untaggedTurns,
    tagCounts: Object.fromEntries([...tagCounts.entries()].sort((a, b) => b[1] - a[1])),
    splitSuggested: tagCounts.size > 1,
    plan,
    t0Candidates,
  };
}

/**
 * 健康摘要（只读）：覆盖率 + 投影状态。
 *
 * 这两项以前要手跑 selfcheck；现在跟着 save 回执一起给出，失败才需动作。
 */
export function summarizeHealth({ events = [], threads = [], projection = null, now = Date.now() } = {}) {
  const messageSeqs = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'user/message' && event?.type !== 'assistant/message') continue;
    const seq = Number(event?.seq);
    if (Number.isInteger(seq)) messageSeqs.push(seq);
  }
  const ranges = [];
  for (const thread of Array.isArray(threads) ? threads : []) {
    for (const segment of thread?.segments ?? []) {
      const from = Number(segment?.fromSeq);
      const to = Number(segment?.toSeq);
      if (Number.isInteger(from) && Number.isInteger(to)) ranges.push([from, to]);
    }
  }
  let uncovered = 0;
  for (const seq of messageSeqs) {
    if (!ranges.some(([from, to]) => seq >= from && seq <= to)) uncovered += 1;
  }
  const coveragePct = messageSeqs.length === 0 ? 100 : Number(((messageSeqs.length - uncovered) / messageSeqs.length * 100).toFixed(2));

  const ageMin = projection === null || typeof projection?.at !== 'string'
    ? null
    : Number(((now - Date.parse(projection.at)) / 60000).toFixed(1));

  return {
    coveragePct,
    uncovered,
    messages: messageSeqs.length,
    projectionStage: projection?.stage ?? null,
    projectionAgeMin: ageMin,
    projected: Number(projection?.projected ?? 0),
    skipped: projection?.skipped ?? {},
  };
}
