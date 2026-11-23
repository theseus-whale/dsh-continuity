import { sha256 } from './config.mjs';

export const CLUE_NOTE = '摘要仅作定位：按 seq 回读；追溯用原文措辞＋beforeSeq 查更早。无命中≠不存在。';

const turnIndex = (turns) => {
  const sorted = [...turns].sort((a, b) => a.seqStart - b.seqStart);
  const map = new Map();
  sorted.forEach((turn, index) => map.set(turn.turnId, { turn, index, sorted }));
  return map;
};

export function buildPing({ summaryByTurn, retrieval, turns, config }) {
  const lookup = turnIndex(turns);
  const lines = [];
  let omittedHigh = 0;
  let shownHits = 0;
  for (const facet of retrieval.facets) {
    const shown = [];
    for (const candidate of facet.high) {
      if (shown.length >= facet.show) break;
      const summary = summaryByTurn.get(candidate.turnId);
      if (!summary) continue;
      const position = lookup.get(candidate.turnId);
      if (!position) continue;
      const before = position.sorted[position.index - 1] ?? null;
      const after = position.sorted[position.index + 1] ?? null;
      const seqRefs = facet.high.slice(0, config.retrieval.maxSeqRefsPerFacet).map((item) => {
        const turn = lookup.get(item.turnId)?.turn;
        return turn ? `${turn.turnId}:${turn.seqStart}-${turn.seqEnd}` : null;
      }).filter(Boolean);
      shownHits += 1;
      shown.push([
        `- HIT ${summary.turnId}｜seq ${summary.seqStart}-${summary.seqEnd}｜${summary.summaryText}`,
        '  Local seq only:',
        `    before=${before ? `${before.turnId}:${before.seqStart}-${before.seqEnd}` : 'none'}`,
        `    after=${after ? `${after.turnId}:${after.seqStart}-${after.seqEnd}` : 'none'}`,
        `  Seq ranges: ${seqRefs.join(', ')}`,
      ].join('\n'));
    }
    omittedHigh += Math.max(0, facet.high.length - shown.length);
    if (shown.length === 0) continue;
    lines.push(`[记忆共振｜主题 ${facet.index + 1}｜high=${facet.H}｜show=${shown.length}]`, ...shown);
  }
  const base = lines.join('\n');
  const hint = shownHits > 0 ? CLUE_NOTE : '';
  const hintBytes = Buffer.byteLength(hint, 'utf8');
  const bodyLimit = hint === '' ? config.retrieval.maxPingUtf8Bytes : Math.max(0, config.retrieval.maxPingUtf8Bytes - hintBytes - 2);
  let text = base;
  let clipped = false;
  if (Buffer.byteLength(text, 'utf8') > bodyLimit) {
    const parts = text.split('\n');
    while (Buffer.byteLength(parts.join('\n'), 'utf8') > bodyLimit) {
      const removed = parts.pop();
      if (removed?.startsWith('- HIT ')) omittedHigh += 1;
    }
    text = parts.join('\n');
    clipped = true;
  }
  if (hint) text = text ? `${text}\n\n${hint}` : hint;
  return { text, bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256(text), clipped, omittedHigh };
}
