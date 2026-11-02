/**
 * T0 闸的纯逻辑：算“即将折叠的区间里还有多少条未决”。
 *
 * 口径（与 T0-POLICY.md 一致）：
 *  - 只看**可见文本**：用户全文 + 助手非 reasoning 部分（reasoning 是草稿，不算记忆）；
 *  - 注入噪音（[线]/[候选]/runtime…）不计；
 *  - 有标签 = 已定；`t0-decisions.jsonl` 里 `as:"t0"` = 显式判定的 T0；其余 = 未决。
 */
import { tagsAtSeq } from './tags.mjs';

export const NOISE_RE = /^(\[线\]|\[标签\]|\[习惯|\[技能|\[归位|\[回查|\[痕迹|\[接手|\[候选|\[新标签|\[归拢|\[学习|\[分叉|\[存\?|\[回正|\[放|\[暂停\]|\[打标|\[话题\?|\[基础规则|\[存活\]|<system-reminder>|<workspace|This is an automatically generated checkpoint|Current runtime context|Time sampled)/;

/** 可见文本：用户全文；助手只取非 reasoning 部分。 */
export function visibleText(event) {
  const msg = event?.data?.message;
  const parts = msg?.content;
  if (Array.isArray(parts)) {
    return parts
      .filter((part) => part?.type !== 'reasoning')
      .map((part) => part?.text ?? '')
      .join('\n')
      .trim();
  }
  const direct = event?.data?.content;
  if (typeof direct === 'string') return direct.trim();
  if (Array.isArray(direct)) {
    return direct
      .filter((part) => part?.type !== 'reasoning')
      .map((part) => part?.text ?? '')
      .join('\n')
      .trim();
  }
  return '';
}

/**
 * @returns {{ content:number, tagged:number, t0Decided:number, undecided:Array<{seq:number,type:string,head:string}> }}
 */
export function contentUndecided({ events = [], tagsDoc = null, decisions = [], turnTagRows = [], fromSeq = 0, toSeq = Infinity } = {}) {
  // 轮标签：调用方一直传 turnTagRows，但函数签名没接——于是在这里抛 ReferenceError，
  // 又被 save 的 catch 吞掉，四道闸集体静默失效（历史调试 反向验收抓到：一批无标签也存了）。
  const taggedTurns = new Set();
  for (const row of Array.isArray(turnTagRows) ? turnTagRows : []) {
    const turn = Number(row?.turn);
    if (Number.isInteger(turn)) taggedTurns.add(turn);
  }
  const decided = new Set();
  const explicitT0 = new Set();
  for (const row of Array.isArray(decisions) ? decisions : []) {
    const seqs = Array.isArray(row?.seqs) ? row.seqs : [row?.seq];
    for (const raw of seqs) {
      const seq = Number(raw);
      if (!Number.isInteger(seq)) continue;
      decided.add(seq);
      if (row?.as === 't0') explicitT0.add(seq);
    }
  }

  let content = 0;
  let tagged = 0;
  let t0Decided = 0;
  let noTurn = 0;
  const undecided = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'user/message' && event?.type !== 'assistant/message') continue;
    const seq = Number(event?.seq);
    if (!Number.isInteger(seq) || seq < fromSeq || seq > toSeq) continue;
    const text = visibleText(event);
    if (text.length === 0) continue;
    if (NOISE_RE.test(text)) continue;
    const source = event?.data?.message?.source ?? event?.data?.source;
    if (source?.peer === true) continue;
    if (typeof source?.kind === 'string' && source.kind !== 'user') continue;
    // Host 可能把 source 的额外字段洗掉，只留 kind:"user"；[peer]/[gate] 是投递侧的稳定前缀。
    if (/^\[(?:peer|gate)(?:\]|·)/.test(text)) continue;
    content += 1;
    const tags = tagsDoc === null ? [] : [...tagsAtSeq(tagsDoc, seq)].filter((tag) => tag !== 'T0');
    if (tags.length > 0) { tagged += 1; continue; }
    if (explicitT0.has(seq)) { t0Decided += 1; continue; }
    if (decided.has(seq)) { tagged += 1; continue; } // 已判给某标签（memberships 可能尚未写入）
    const turnNumber = Number(event?.data?.turn);
    if (Number.isInteger(turnNumber) && taggedTurns.has(turnNumber)) { tagged += 1; continue; } // 轮标签已判
    // 没有轮号 ≠ 不用判：归属靠 run 区间（[from,to,tagId]），run 不需要轮号。
    // 之前这里写「无轮号 → 跳过」，等于把 一批真实用户消息当成不用管（历史调试 用户纠正）。
    if (!Number.isInteger(turnNumber)) noTurn += 1;
    undecided.push({ seq, type: event.type, head: text.replace(/\s+/g, ' ').slice(0, 60) });
  }
  return { content, tagged, t0Decided, noTurn, undecided };
}


/**
 * 这次折叠覆盖到、但还没有轮标签的轮。
 * @returns {Array<{turn:number, seq:number}>}
 */
export function untaggedTurnList({ events = [], turnTagRows = [], fromSeq = 0, toSeq = Infinity } = {}) {
  const tagged = new Set();
  for (const row of Array.isArray(turnTagRows) ? turnTagRows : []) {
    const turn = Number(row?.turn);
    if (Number.isInteger(turn)) tagged.add(turn);
  }
  const out = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'user/message' && event?.type !== 'assistant/message') continue;
    const turn = Number(event?.data?.turn);
    const seq = Number(event?.seq);
    if (!Number.isInteger(turn) || !Number.isInteger(seq)) continue;
    if (seq < fromSeq || seq > toSeq) continue;
    if (tagged.has(turn)) continue;
    if (!out.has(turn)) out.set(turn, { turn, seq });
  }
  return [...out.values()];
}


/**
 * 全局轮标签缺口：已结束的轮里，有多少轮还没有标签。
 * 这是“机制是否漏打”的判据——缺口大就不是没轮到，是漏了。
 *
 * @returns {{settled:number, tagged:number, missing:Array<{turn:number, hasUserText:boolean}>}}
 */
export function turnTagGap({ events = [], turnTagRows = [], boundaryTurn = Infinity } = {}) {
  const tagged = new Set();
  for (const row of Array.isArray(turnTagRows) ? turnTagRows : []) {
    const turn = Number(row?.turn);
    if (Number.isInteger(turn)) tagged.add(turn);
  }
  const withMessages = new Map();
  let maxTurn = 0;
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'user/message' && event?.type !== 'assistant/message') continue;
    const turn = Number(event?.data?.turn);
    if (!Number.isInteger(turn)) continue;
    if (turn > maxTurn) maxTurn = turn;
    const entry = withMessages.get(turn) ?? { turn, hasUserText: false };
    if (event.type === 'user/message') entry.hasUserText = true;
    withMessages.set(turn, entry);
  }
  const settledBoundary = Math.min(Number.isFinite(boundaryTurn) ? boundaryTurn : Infinity, maxTurn - 1);
  const missing = [];
  let settled = 0;
  for (const entry of withMessages.values()) {
    if (entry.turn > settledBoundary) continue;
    settled += 1;
    if (!tagged.has(entry.turn)) missing.push({ turn: entry.turn, hasUserText: entry.hasUserText });
  }
  missing.sort((left, right) => left.turn - right.turn);
  return { settled, tagged: settled - missing.length, missing };
}
