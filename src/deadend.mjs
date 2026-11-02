/**
 * C7 死胡同症状检测（纯函数）。
 *
 * 两条可数症状 + 一条强制提问：
 *   1. sameSpot   ：同一路径在窗口内被改 ≥ limit 次（“同处改三版”）
 *   2. fixLoop    ：同一个错误签名在“改动之后”再次出现 ≥2 次（“每次都在补上一版的洞”）
 *   3. noCriteria ：这一轮在改东西，但回复里没有判据/验收/测试（“说不清改完怎样”）
 *
 * 注意：它只报症状，不判“是不是死胡同”——那个判断仍归实例。
 */

export function pathFromArguments(name, argumentsText) {
  if (typeof argumentsText !== 'string' || argumentsText.length === 0) return null;
  if (name !== 'edit' && name !== 'write') return null;
  try {
    const parsed = JSON.parse(argumentsText);
    const path = parsed?.file_path ?? parsed?.path;
    return typeof path === 'string' && path.length > 0 ? path : null;
  } catch {
    const match = argumentsText.match(/"file_path"\s*:\s*"([^"]+)"/);
    return match === null ? null : match[1];
  }
}

/** 为将来多路径留接口；当前只有 edit/write 可靠，所以最多一个。 */
export function pathsFromArguments(name, argumentsText) {
  const single = pathFromArguments(name, argumentsText);
  return single === null ? [] : [single];
}

export function detectDeadEnds({
  toolCalls = [],
  replies = [],
  errors = [],
  windowTurns = 8,
  limit = 3,
} = {}) {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  const maxTurn = calls.reduce((max, call) => Math.max(max, Number(call?.turn) || 0), 0);
  const recent = calls.filter((call) => (Number(call?.turn) || 0) > maxTurn - windowTurns);

  // 1) 同处改三版
  const byPath = new Map();
  for (const call of recent) {
    const paths = Array.isArray(call?.paths) ? call.paths : (typeof call?.path === 'string' ? [call.path] : []);
    for (const path of paths) {
      if (typeof path !== 'string' || path.length === 0) continue;
      const entry = byPath.get(path) ?? { path, turns: new Set(), count: 0 };
      entry.turns.add(Number(call?.turn) || 0);
      entry.count += 1;
      byPath.set(path, entry);
    }
  }
  const sameSpot = [...byPath.values()]
    .filter((entry) => entry.turns.size >= limit)
    .map((entry) => ({ path: entry.path, turns: entry.turns.size, edits: entry.count }))
    .sort((left, right) => right.turns - left.turns);

  // 2) 修完仍同错：同一签名在改动之后又出现
  const editedTurns = new Set(recent.map((call) => Number(call?.turn) || 0));
  const bySig = new Map();
  for (const error of Array.isArray(errors) ? errors : []) {
    const sig = error?.sig;
    if (typeof sig !== 'string' || sig.length === 0) continue;
    const turn = Number(error?.turn) || 0;
    if (!editedTurns.has(turn)) continue;
    const entry = bySig.get(sig) ?? { sig, turns: new Set() };
    entry.turns.add(turn);
    bySig.set(sig, entry);
  }
  const fixLoop = [...bySig.values()]
    .filter((entry) => entry.turns.size >= 2)
    .map((entry) => ({ sig: entry.sig, turns: entry.turns.size }));

  // 3) 说不清改完怎样
  const lastReply = (Array.isArray(replies) ? replies : [])
    .slice()
    .sort((left, right) => (Number(left?.turn) || 0) - (Number(right?.turn) || 0))
    .at(-1);
  const text = typeof lastReply?.text === 'string' ? lastReply.text : '';
  // 只在“真的动手改”的轮里才问判据：这一轮必须有 edit/write 调用。
  // 否则讲哲学、讨论方案也会被误报（第一次上线就是这么翻车的）。
  const lastTurn = Number(lastReply?.turn) || 0;
  const touchedFiles = editedTurns.has(lastTurn);
  const CHANGE_VERB = /(改成|修改|改一下|改代码|改文件|打补丁|patch\s*(一下|掉)?|调整成|重写)/;
  const changesSomething = touchedFiles && CHANGE_VERB.test(text);
  const hasCriteria = /判据|验收|测试|验证|证据|怎么算成功|标准/.test(text);
  const noCriteria = changesSomething && !hasCriteria;

  const symptoms = [];
  if (sameSpot.length > 0) symptoms.push('同处改多版：' + sameSpot.slice(0, 2).map((entry) => entry.path + '（' + entry.turns + ' 轮）').join('、'));
  if (fixLoop.length > 0) symptoms.push('改完仍同错：' + fixLoop.slice(0, 2).map((entry) => entry.sig).join('、'));
  if (noCriteria) symptoms.push('这条改动缺验收标准');
  return { sameSpot, fixLoop, noCriteria, symptoms };
}
