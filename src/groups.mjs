/**
 * 归拢探测（纯函数）：从标签关键词与 multi-hit 日志里提出“该有父”的候选。
 * 只提议，不建组；名字优先取查询原话，其次取共享词。
 */
const SCAFFOLD = new Set(["T", "标签", "记录", "线头", "thread", "tag"]);

export function normalizeTags(tags) {
  return Object.entries(tags?.tags ?? {}).map(([id, t]) => ({
    id,
    alias: t?.alias ?? id,
    label: t?.label ?? "",
    keywords: Array.isArray(t?.keywords) ? t.keywords.filter((k) => k && !SCAFFOLD.has(k)) : [],
  }));
}

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** 返回提议数组；每条 {kind, members, score, name}。 */
export function detectGroups(tags, routeLines = [], options = {}) {
  const minJaccard = Number(options.minJaccard ?? 0.5);
  const minPairHits = Number(options.minPairHits ?? 2);
  const rawEntries = normalizeTags(tags);
  const entries = options.groups ? collapseGroups(rawEntries, options.groups) : rawEntries;
  const proposals = [];

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i], b = entries[j];
      const score = jaccard(a.keywords, b.keywords);
      if (score < minJaccard) continue;
      const shared = a.keywords.filter((k) => b.keywords.includes(k));
      proposals.push({ kind: "keyword-overlap", members: [a.alias, b.alias], score: Number(score.toFixed(2)), name: shared[0] ?? "" });
    }
  }

  const multi = routeLines
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((x) => x && typeof x.conclusion === "string" && x.conclusion.startsWith("multi:"))
    .map((x) => ({ head: x.head ?? "", tags: x.conclusion.slice(6).split(",").filter(Boolean) }));
  const pair = new Map();
  for (const m of multi) {
    for (let i = 0; i < m.tags.length; i++) {
      for (let j = i + 1; j < m.tags.length; j++) {
        const key = [m.tags[i], m.tags[j]].sort().join("|");
        const cur = pair.get(key) ?? { count: 0, head: m.head };
        cur.count++;
        pair.set(key, cur);
      }
    }
  }
  for (const [key, v] of pair) {
    if (v.count < minPairHits) continue;
    // 父名优先取成员关键词的交集；没有就留空（由实例或人提炼），原句只作凭据。
    const ids = key.split("|");
    const kws = ids.map((id) => entries.find((e) => e.alias === id || e.id === id)?.keywords ?? []);
    const shared = kws.length >= 2 ? kws[0].filter((k) => kws[1].includes(k)) : [];
    proposals.push({ kind: "query-ambiguity", members: ids, score: v.count, name: shared[0] ?? "", evidence: String(v.head).slice(0, 60) });
  }
  return proposals;
}


/**
 * 按 groups 把成员标签折叠成一个节点（组名），避免同一主题的多个阶段被当成独立标签。
 * groups 形如 { "标签治理": { members: ["T16","T21"] } }。
 */
export function collapseGroups(entries, groups) {
  const byMember = new Map();
  for (const [name, g] of Object.entries(groups ?? {})) {
    for (const m of g?.members ?? []) byMember.set(m, name);
  }
  const collapsed = new Map();
  for (const e of entries) {
    const key = byMember.get(e.alias) ?? byMember.get(e.id) ?? e.alias ?? e.id;
    const cur = collapsed.get(key) ?? { id: key, alias: key, label: groups?.[key]?.label ?? e.label, keywords: [] };
    cur.keywords.push(...e.keywords);
    collapsed.set(key, cur);
  }
  return [...collapsed.values()];
}


/**
 * 把组名递归展开成标签 id 集合。members 里可以嵌套组名。
 * 环引用直接抛错（A⊃B⊃A 是数据错误，不该静默）。
 */
export function expandGroup(groups, name, seen = new Set()) {
  if (!groups || typeof groups !== "object") return new Set();
  if (!groups[name]) throw new Error("未知组: " + name);
  if (seen.has(name)) throw new Error("组循环引用: " + [...seen, name].join(" -> "));
  const next = new Set(seen);
  next.add(name);
  const out = new Set();
  for (const member of groups[name].members ?? []) {
    if (groups[member]) {
      for (const id of expandGroup(groups, member, next)) out.add(id);
    } else {
      out.add(member);
    }
  }
  return out;
}


/**
 * 从多命中证据里提炼父名：取这些句子里反复出现、但不在两个标签关键词里的 2–4 字词。
 * 找不到就返回空串（交给提问）。
 */
export function nameFromEvidence(heads, keywordsA = [], keywordsB = []) {
  const banned = new Set([...(keywordsA ?? []), ...(keywordsB ?? [])]);
  const texts = (heads ?? []).map((h) => String(h ?? ""));
  const df = new Map();
  for (const text of texts) {
    const seen = new Set();
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= text.length; i++) {
        const g = text.slice(i, i + n);
        if (!/^[\u4e00-\u9fa5]+$/.test(g)) continue;
        if (banned.has(g)) continue;
        seen.add(g);
      }
    }
    for (const g of seen) df.set(g, (df.get(g) ?? 0) + 1);
  }
  // 词边界：真词两侧要么“干净”（句首/标点），要么邻字多样；碎片两侧恒定（如“机性”）。
  const isBoundary = (ch) => ch === "" || /[\s，。！？、；：""''（）()\[\]【】—…·]/.test(ch);
  const sideOk = (term, side) => {
    const map = new Map();
    let allBoundary = true;
    for (const text of texts) {
      let i = -1;
      while ((i = text.indexOf(term, i + 1)) >= 0) {
        const ch = side === "prev" ? (i > 0 ? text[i - 1] : "") : (i + term.length < text.length ? text[i + term.length] : "");
        if (!isBoundary(ch)) { allBoundary = false; map.set(ch, (map.get(ch) ?? 0) + 1); }
      }
    }
    if (allBoundary) return true;
    const total = [...map.values()].reduce((a, b) => a + b, 0);
    if (total === 0) return true;
    let h = 0;
    for (const c of map.values()) { const p2 = c / total; h -= p2 * Math.log2(p2); }
    return h >= 0.9;
  };
  const boundaryOk = (term) => sideOk(term, "prev") && sideOk(term, "next");
  // 与标签关键词共享 ≥2 字的片段也算“已有关键词的一部分”，不能当父名（如“机性价”）。
  const grams2 = (s) => { const out = new Set(); for (let i = 0; i + 2 <= s.length; i++) out.add(s.slice(i, i + 2)); return out; };
  const bannedSub = (g) => {
    const gg = grams2(g);
    return [...banned].some((k) => {
      if (typeof k !== "string" || k.length < 2) return false;
      if (g.includes(k) || k.includes(g)) return true;
      for (const x of grams2(k)) if (gg.has(x)) return true;
      return false;
    });
  };
  const ranked = [...df.entries()]
    // 长词（≥3）比 2 字词可靠；2 字词必须两侧都多样，否则多半是碎片。
    .filter(([g, c]) => c >= 2 && !bannedSub(g) && (g.length >= 3 || boundaryOk(g)))
    .sort((a, b) => (b[0].length - a[0].length) || (b[1] - a[1]));
  return ranked.length > 0 ? ranked[0][0] : "";
}
