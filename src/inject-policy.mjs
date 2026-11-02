/**
 * 注入判定（纯函数）：什么时候需要把“必须一直可见”的正文补注入。
 * 判据不是“注入过没有”，而是“承载它的消息现在还在不在 surface 里”。
 */

/** 规则全文：内容变了、没有承载 seq，或承载 seq 已不在 surface → 需要注入。 */
export function needsFullInjection({ text, carrierSeq, surfaceSeqs, changed = false }) {
  if (!text || text.length === 0) return false;
  if (changed === true) return true;
  if (carrierSeq === undefined || carrierSeq === null) return true;
  return !surfaceSeqs.has(carrierSeq);
}

/** 技能正文：只在技能集合变化时注入；之后只保留 `[技能] 正在用` 一行。 */
export function needsSkillInjection({ keyChanged } = {}) {
  return keyChanged === true;
}
