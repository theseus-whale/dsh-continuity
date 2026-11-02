/**
 * 轮标签投影（纯函数）。
 *
 * 消息级标签由引擎自动写入 tags.json；turn-tags.jsonl 只是它的“物化视图”。
 * 这里只做投影：不判断、不匹配，只数多数派。
 *
 * 规则：
 *   - 忽略 T0（那是“未分类”桶，不能当轮标签）；
 *   - 需要至少 minShare 的份额（默认 0.6）才算可投影；
 *   - 打平或全 T0 → null（交给实例判断）。
 */
/**
 * 把 surface 顺序的消息归到轮（纯函数）。
 *
 * 为什么需要它：`user/message` 事件没有 `data.turn`，只按 data.turn 分组会把
 * 用户消息全部丢掉，整轮只剩 assistant 消息 → 全是 T0 → 投影永远 no-tag。
 *
 * 规则：用户消息归到“它后面第一条带轮号的 assistant 消息”所属的轮；
 * 末尾没有后续 assistant 的（当轮还没产出）不归属。
 *
 * @param ordered [{ seq, type: 'user/message'|'assistant/message', turn: number|null }]
 * @returns { turnSeqs: Map<number, number[]>, maxTurn: number }
 */
export function attributeTurnSeqs(ordered = []) {
  const list = Array.isArray(ordered) ? ordered : [];
  const turnSeqs = new Map();
  for (let index = 0; index < list.length; index += 1) {
    const row = list[index];
    if (!Number.isInteger(Number(row?.seq))) continue;
    let turn = Number.isInteger(row?.turn) ? row.turn : null;
    if (turn === null) {
      for (let later = index + 1; later < list.length; later += 1) {
        if (Number.isInteger(list[later]?.turn)) { turn = list[later].turn; break; }
      }
    }
    if (turn === null) continue;
    const bucket = turnSeqs.get(turn) ?? [];
    bucket.push(Number(row.seq));
    turnSeqs.set(turn, bucket);
  }
  const maxTurn = turnSeqs.size === 0 ? 0 : Math.max(...turnSeqs.keys());
  return { turnSeqs, maxTurn };
}

export function deriveTurnTag({ messages = [], minShare = 0.6 } = {}) {
  const counts = new Map();
  let total = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    const tag = String(message?.tag ?? '');
    if (tag.length === 0 || tag === 'T0') continue;
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
    total += 1;
  }
  if (total === 0) return { tag: null, reason: 'no-tag' };
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1]);
  const [topTag, topCount] = ranked[0];
  const secondCount = ranked[1]?.[1] ?? 0;
  if (topCount === secondCount) return { tag: null, reason: 'tie' };
  const share = topCount / total;
  if (share < minShare) return { tag: null, reason: 'weak-majority', share: Number(share.toFixed(2)) };
  return { tag: topTag, reason: 'majority', share: Number(share.toFixed(2)) };
}
