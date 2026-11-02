import fs from 'node:fs';

/**
 * 学习候选：从工具回执里找“同一类错误”，聚合成候选教训。
 * 只做发现与计数；写规则仍由实例决定（插件只把候选和提问推给实例）。
 */
export const ERROR_RE = /(SyntaxError|TypeError|ReferenceError|RangeError|Cannot find module|EPERM|ENOENT|Traceback|anchor count [1-9]|Unexpected token|is not a function|undefined is not)/;

/** 把一条回执归一成一个签名；不是错误就返回 null。 */
export function signatureOf(text) {
  const body = String(text ?? "");
  // 探针不算教训：带 PROBE_ 的签名是我们自己刻意制造的失败。
  if (body.includes("PROBE_")) return null;
  if (!body) return null;
  // 只学“真正失败”的回执：harness 对非零退出会追加 [exit code: N]。
  // 正常退出的脚本即使文字里引用了错误行，也不算教训（否则会学自己的报告）。
  if (!/\[exit code: [1-9]\d*\]/.test(body)) return null;
  const line = body.split("\n").find((l) => ERROR_RE.test(l) && !/^\s*\[/.test(l) && !/^\s*\d+x\s/.test(l) && !/\(seq \d+\.\.\d+\)/.test(l));
  if (!line) return null;
  return line
    .replace(/[A-Za-z]:\\[^\s"']+/g, "<path>")
    .replace(/\d+/g, "<n>")
    .trim()
    .slice(0, 140);
}

/** 记一次出现。返回签名（或 null）。 */
export function note(map, seq, text) {
  const sig = signatureOf(text);
  if (sig === null) return null;
  const cur = map.get(sig) ?? { count: 0, firstSeq: null, lastSeq: null };
  cur.count += 1;
  // 扫描顺序是从新到旧，所以 first/last 按 seq 数值取 min/max，不能按"先见到"。
  cur.firstSeq = cur.firstSeq === null ? seq : Math.min(cur.firstSeq, seq);
  cur.lastSeq = cur.lastSeq === null ? seq : Math.max(cur.lastSeq, seq);
  map.set(sig, cur);
  return sig;
}

/** 出现 ≥ min 次的候选，按次数降序。 */
export function topCandidates(map, min = 2, limit = 3) {
  return [...map.entries()]
    .filter(([, g]) => g.count >= min)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, limit)
    .map(([sig, g]) => ({ sig, count: g.count, firstSeq: g.firstSeq, lastSeq: g.lastSeq }));
}

/**
 * 扫描给定节点里新增的 tool/result，记入 map。
 * 返回新的 cursor；纯函数，便于离线用真实事件验证。
 */
export function scanResults(map, { nodes, eventAt, cursor = 0, init = false, lookback = 500 }) {
  const list = Array.isArray(nodes) ? nodes : nodes ? [...nodes] : [];
  let maxSeq = cursor;
  // init=true：从尾扫到 0（cursor 会提前停）；首次：只回看**最新的** lookback 个节点。
  const lowest = init ? 0 : Math.max(0, list.length - lookback);
  for (let i = list.length - 1; i >= lowest; i--) {
    const seq = list[i];
    if (typeof seq !== 'number' || seq <= cursor) continue;
    if (seq > maxSeq) maxSeq = seq;
    const event = eventAt(seq);
    if (event?.type !== 'tool/result') continue;
    const c = event.data?.message?.content ?? event.data?.content ?? [];
    const body = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text ?? '').join(' ') : '';
    note(map, seq, body);
  }
  return maxSeq;
}
/** 读已答记录（每行 {sig, decision}），返回签名集合。 */
export function loadAnswered(file) {
  const set = new Set();
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { const row = JSON.parse(line); if (row?.sig) set.add(row.sig); } catch { /* 坏行跳过 */ }
    }
  } catch { /* 文件不存在 = 没有已答记录 */ }
  return set;
}

/** 过滤掉已答过的候选（按完整签名或前缀匹配）。 */
export function filterAnswered(candidates, answered) {
  const list = [...answered];
  // 历史记录可能只存了前缀，且前缀可能位于签名中间：用双向包含判定。
  return candidates.filter((c) => !list.some((a) => a && (c.sig === a || c.sig.includes(a) || a.includes(c.sig))));
}