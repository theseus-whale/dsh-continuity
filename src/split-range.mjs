/**
 * 把“待保存区间”按轮标签切成话题段（纯函数，可单测）。
 *
 * 规则：
 *   1. 每轮一个标签（T0 视为无归属）；
 *   2. 相邻同标签合并；T0 段并入前一段（没有前一段就并入后一段）；
 *   3. 小于 minTurns 的段并入相邻段（避免切出一堆碎段）；
 *   4. 只按 seq 区间切，不跨轮切。
 *
 * @returns {Array<{tag:string, fromSeq:number, toSeq:number, turns:number}>}
 */
export function planSplits({ turns = [], tagOf = new Map(), fromSeq = 0, toSeq = Infinity, minTurns = 2 } = {}) {
  const items = [];
  for (const info of Array.isArray(turns) ? turns : []) {
    const seqs = (info?.seqs ?? []).filter((seq) => Number.isInteger(Number(seq)) && Number(seq) >= fromSeq && Number(seq) <= toSeq);
    if (seqs.length === 0) continue;
    const tag = String(tagOf.get(Number(info.turn)) ?? 'T0');
    items.push({ turn: Number(info.turn), tag, from: Math.min(...seqs.map(Number)), to: Math.max(...seqs.map(Number)) });
  }
  items.sort((left, right) => left.from - right.from);
  if (items.length === 0) return [];

  // 1) 同标签相邻合并（T0 先不合并）
  const runs = [];
  for (const item of items) {
    const last = runs.at(-1);
    if (last !== undefined && last.tag === item.tag && item.tag !== 'T0') { last.to = Math.max(last.to, item.to); last.turns += 1; continue; }
    runs.push({ tag: item.tag, from: item.from, to: item.to, turns: 1 });
  }

  // 2) T0 并入邻段
  const merged = [];
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    if (run.tag !== 'T0') { merged.push(run); continue; }
    const prev = merged.at(-1);
    if (prev !== undefined) { prev.to = Math.max(prev.to, run.to); prev.turns += run.turns; continue; }
    const next = runs.slice(index + 1).find((row) => row.tag !== 'T0');
    if (next === undefined) continue;
    next.from = Math.min(next.from, run.from);
    next.turns += run.turns;
  }

  // 3) 小段并入邻段（优先前）
  const out = [];
  for (const run of merged) {
    const prev = out.at(-1);
    if (prev !== undefined && run.turns < minTurns) { prev.to = Math.max(prev.to, run.to); prev.turns += run.turns; continue; }
    out.push({ ...run });
  }
  if (out.length > 1 && out[0].turns < minTurns) {
    out[1] = { ...out[1], from: Math.min(out[0].from, out[1].from), turns: out[0].turns + out[1].turns };
    out.shift();
  }

  // 4) 相邻同标签再合并一次
  const final = [];
  for (const run of out) {
    const last = final.at(-1);
    if (last !== undefined && last.tag === run.tag) { last.to = Math.max(last.to, run.to); last.turns += run.turns; continue; }
    final.push(run);
  }
  return final.map((run) => ({ tag: run.tag, fromSeq: run.from, toSeq: run.to, turns: run.turns }));
}

/**
 * 把区间内的轮按标签切成连续块（不合并、不筛选）。
 * 相邻同标签 = 一块；标签一变就断开。
 *
 * @returns {Array<{tag:string, fromSeq:number, toSeq:number, turns:number}>}
 */
export function blocksByTag({ events = [], tagOf = new Map(), fromSeq = 0, toSeq = Infinity } = {}) {
  const byTurn = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'user/message' && event?.type !== 'assistant/message') continue;
    // user/message 没有 data.turn（结构性事实）；调用方可以先用 attributeTurnSeqs 把轮号
    // 填到 event.turn 上。只认 data.turn 会把用户原话排除在折叠边界之外——那正是
    // “想找原话却折不进去”的根源（2026-10-30 实测：块起点落在 assistant 而不是 user）。
    const turn = Number(event?.data?.turn ?? event?.turn);
    const seq = Number(event?.seq);
    if (!Number.isInteger(turn) || !Number.isInteger(seq)) continue;
    if (seq < fromSeq || seq > toSeq) continue;
    const entry = byTurn.get(turn) ?? { turn, seqs: [], tag: String(tagOf.get(turn) ?? 'T0') };
    entry.seqs.push(seq);
    byTurn.set(turn, entry);
  }
  const ordered = [...byTurn.values()].sort((left, right) => Math.min(...left.seqs) - Math.min(...right.seqs));
  const blocks = [];
  for (const entry of ordered) {
    const last = blocks.at(-1);
    if (last !== undefined && last.tag === entry.tag) last.turns.push(entry);
    else blocks.push({ tag: entry.tag, turns: [entry] });
  }
  return blocks.map((block) => ({
    tag: block.tag,
    fromSeq: Math.min(...block.turns.flatMap((entry) => entry.seqs)),
    toSeq: Math.max(...block.turns.flatMap((entry) => entry.seqs)),
    turns: block.turns.length,
  }));
}

/**
 * save 的机械分段：只取「属于 target 的连续轮块」。
 * 相邻同标签的轮合成一块；标签一变就断开——所以不会跨过别的标签去折。
 *
 * 这是 save() 折叠范围的唯一依据：切到 T2 时，T4 的块被折、T2 的块原地留着。
 *
 * @returns {Array<{fromSeq:number, toSeq:number, turns:number}>}
 */
export function runsForThread({ events = [], tagOf = new Map(), fromSeq = 0, toSeq = Infinity, target = '' } = {}) {
  if (String(target).length === 0) return [];
  return blocksByTag({ events, tagOf, fromSeq, toSeq })
    .filter((block) => block.tag === String(target))
    .map((block) => ({ fromSeq: block.fromSeq, toSeq: block.toSeq, turns: block.turns }));
}
