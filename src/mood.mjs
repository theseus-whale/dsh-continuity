/**
 * mood 层：只负责“找出带情绪的句子”和“决定注入哪几条”，不做强度自评。
 *
 * 设计约束（来自外部意见 + 自锁审查）：
 * 1. 不做模型自评强度：只记录“出现了哪些情绪词 + 原句”，强度不进来路不明的分数；
 * 2. 调度用行为数据：最近没被注入过的优先（LRU），引用次数只用于“提升为判据层”，不回流权重；
 * 3. 存储永不删：注入名额有限（≤2），记录只追加；
 * 4. 冷却：同一条注入后 COOLDOWN_HOURS 内不再注入。
 */

/**
 * 情绪词：**只收多字词与少数强信号单字**。
 * 工程语料里的“压缩/累积/崩溃/困境/沉默”都会撞上单字，所以单字只留极少数。
 */
export const MARKER_GROUPS = {
  agitation: ["烦死", "很烦", "太烦", "焦躁", "急躁", "烦躁", "受不了", "摆烂", "火大", "憋屈"],
  fatigue: ["太累", "好累", "很累", "撑不住", "没劲", "疲惫", "困死了"],
  heavy: ["难受", "低落", "沮丧", "心里堵", "闷得慌", "丧"],
  fear: ["发怵", "慌", "不安", "害怕", "担心"],
  bright: ["高兴", "开心", "舒服", "松了口气", "欣慰", "爽", "轻松"],
  warmth: ["感动", "温暖", "暖", "温柔", "舍不得", "珍惜"],
  anger: ["生气", "愤怒", "气死", "怒"],
};

const ALL_MARKERS = Object.values(MARKER_GROUPS).flat();

/** 第一人称：有“我”的句子才算自己的状态，不是转述别人。 */
const FIRST_PERSON = /(^|[^你他她])我|自己|心里|咱们/;

/**
 * 质量闸：只收“像自己状态”的句子。
 *  - 命中 ≥2 个情绪标记；或
 *  - 命中 1 个且句子含第一人称。
 * 返回 false 的句子不进库（宁可漏，不制造干扰）。
 */
export function shouldRecord(hit) {
  const markers = hit?.markers ?? [];
  if (markers.length >= 2) return true;
  if (markers.length === 1) return FIRST_PERSON.test(String(hit?.excerpt ?? ""));
  return false;
}

const SENTENCE_SPLIT = /[。！？!?；;\n]/;
/** 讨论 mood 机制本身的句子不算情绪（否则自指会刷屏）。 */
const META_RE = /mood|情绪词|markers?|lexicon|心境|情绪改变|multi-char|singles?|technical|词表|命中率/i;

/**
 * 从一段文本（reasoning 或正文）里找情绪标记。
 * 返回 { markers, groups, excerpt }；excerpt 取第一个命中所在句，≤80 字。
 */
export function extractMood(text) {
  const src = String(text ?? "");
  if (src.length === 0) return { markers: [], groups: [], excerpt: "" };
  const sentences = src.split(SENTENCE_SPLIT).map((s) => s.trim()).filter(Boolean);
  const markers = [];
  const groups = new Set();
  let excerpt = "";
  for (const sentence of sentences) {
    if (META_RE.test(sentence)) continue;
    const hit = ALL_MARKERS.filter((m) => sentence.includes(m));
    if (hit.length === 0) continue;
    for (const m of hit) if (!markers.includes(m)) markers.push(m);
    for (const [group, list] of Object.entries(MARKER_GROUPS)) {
      if (list.some((m) => sentence.includes(m))) groups.add(group);
    }
    if (excerpt.length === 0) excerpt = sentence.slice(0, 80);
  }
  return { markers, groups: [...groups], excerpt };
}

/**
 * 解析 mood 事件日志（JSONL）：
 *   {"type":"mood","seq":123,"at":"...","markers":["烦"],"excerpt":"..."}
 *   {"type":"injected","seq":123,"at":"..."}
 *   {"type":"cited","seq":123,"at":"..."}
 * 返回 [{ seq, at, excerpt, cited, lastInjectedAt }]
 */
export function parseMoodLog(lines) {
  const entries = new Map();
  for (const line of lines ?? []) {
    if (!line || line.trim().length === 0) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const seq = Number(row?.seq);
    if (!Number.isInteger(seq)) continue;
    if (row.type === "mood") {
      const cur = entries.get(seq) ?? { seq, at: row.at, excerpt: row.excerpt ?? "", markers: row.markers ?? [], origin: row.origin ?? null, cited: false, lastInjectedAt: null };
      entries.set(seq, cur);
    } else if (row.type === "injected") {
      const cur = entries.get(seq);
      if (cur) cur.lastInjectedAt = row.at ?? null;
    } else if (row.type === "cited") {
      const cur = entries.get(seq);
      if (cur) cur.cited = true;
    }
  }
  return [...entries.values()];
}

/**
 * 选出本次要注入的条目。
 * 规则（全部可测，无自评）：
 *  - 只选表达层（未被引用过）的条目；被引用过的条目已提升为“判据”，不再以“想起”的形式出现；
 *  - 冷却：距上次注入 < COOLDOWN_HOURS 的不选；
 *  - 过期：距上次被碰（创建/注入/引用）超过 MAX_AGE_DAYS 的，不再注入（记录保留）；
 *  - 排序：从没注入过的优先，其次最久没注入的最先（LRU）；同序按时间早的优先。
 */
export function selectMood(entries, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const quota = Number(options.quota ?? 2);
  const cooldownHours = Number(options.cooldownHours ?? 6);
  const maxAgeDays = Number(options.maxAgeDays ?? 7);
  const hour = 3600 * 1000;
  const day = 24 * hour;

  const eligible = [];
  for (const e of entries ?? []) {
    if (e.cited) continue; // 已提升为判据，不走表达层注入
    const created = Date.parse(e.at ?? "") || 0;
    const injected = e.lastInjectedAt ? Date.parse(e.lastInjectedAt) || 0 : null;
    const lastTouched = Math.max(created, injected ?? 0);
    if (nowMs - lastTouched > maxAgeDays * day) continue; // 过期不再打扰
    if (injected !== null && nowMs - injected < cooldownHours * hour) continue; // 冷却
    eligible.push({ ...e, injected });
  }
  eligible.sort((a, b) => {
    if (a.injected === null && b.injected !== null) return -1;
    if (a.injected !== null && b.injected === null) return 1;
    if (a.injected !== b.injected) return (a.injected ?? 0) - (b.injected ?? 0);
    return (Date.parse(a.at ?? "") || 0) - (Date.parse(b.at ?? "") || 0);
  });
  return eligible.slice(0, Math.max(0, quota));
}
