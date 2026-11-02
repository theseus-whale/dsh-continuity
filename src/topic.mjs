/**
 * 话题提示的判定逻辑（纯函数，可单测）。
 *
 * 判据（历史调试 Continuity 定）：
 *   1. 只认 keywords/anchors；标签名不参与打分，只用于显示；
 *   2. 泛词权重 0；至少 1 个专属词（precision ≥ 0.5 且 hits ≥ 5），或 ≥2 个非泛关键词；
 *   3. 与当前线的分差 ≥ 2；最多 1 个目标；
 *   4. 拿不到专属词 → 静默，不猜。
 */
export function selectTopic({ rows = [], text = '', genericWords = new Set(), wordStats = new Map(), activeId = '' } = {}) {
  const ranked = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.id ?? '');
    if (id.length === 0) continue;
    const keywords = Array.isArray(row?.keywords) ? row.keywords : [];
    const anchors = Array.isArray(row?.anchors) ? row.anchors : [];
    const keywordHits = keywords.filter((word) => typeof word === 'string' && word.length > 0 && text.includes(word));
    const anchorHits = anchors.filter((word) => typeof word === 'string' && word.length > 0 && text.includes(word));
    const matched = [...new Set([...keywordHits, ...anchorHits])];
    if (matched.length === 0) continue;

    // 有显式必需词时，一个都没命中 → 这个标签不参与。
    if (anchors.length > 0 && anchorHits.length === 0) continue;

    const exclusiveOf = (word) => {
      const stats = wordStats instanceof Map ? wordStats.get(word) : wordStats?.[word];
      return Number(stats?.precision) >= 0.5 && Number(stats?.hits) >= 5;
    };
    // anchors 只负责“必须出现”，不得把泛词升格成强证据。
    const strong = matched.filter((word) => !genericWords.has(word));
    const weak = matched.filter((word) => genericWords.has(word));
    const exclusive = strong.filter(exclusiveOf);
    ranked.push({
      id,
      alias: row.alias ?? id,
      label: row.label,
      matched,
      anchors: anchorHits,
      strong,
      weak,
      exclusive,
      score: strong.length * 3,
      overlap: Number((strong.length / matched.length).toFixed(2)),
    });
  }
  ranked.sort((left, right) => right.score - left.score);
  const top = ranked[0];
  const active = ranked.find((row) => row.id === String(activeId));
  const activeScore = active?.score ?? 0;
  const activeStrong = active?.strong.length ?? 0;

  if (top === undefined) return { blocked: true, reason: 'no-match', ranked, top: null };
  if (top.strong.length === 0) return { blocked: true, reason: 'only-generic', ranked, top };
  if (top.exclusive.length === 0 && top.strong.length < 2) {
    return { blocked: true, reason: 'weak-evidence', ranked, top };
  }
  if (top.id === String(activeId)) return { blocked: true, reason: 'already-active', ranked, top };
  if (top.score < activeScore + 2) return { blocked: true, reason: 'not-strong-enough', ranked, top };
  if (activeStrong > 0 && top.strong.length <= activeStrong && top.score < activeScore + 2) {
    return { blocked: true, reason: 'tie', ranked, top };
  }
  return { blocked: false, reason: 'switch-suggested', ranked, top };
}
