/**
 * Fixed facet schema (v1).
 *
 * The schema is deliberately small and closed. The extractor may only emit
 * values listed here; an unknown concept belongs in `unknown`, not in a new
 * facet value. Schema evolution is a separate, versioned operation.
 */
export const SCHEMA_VERSION = 1;

export const SLOTS = Object.freeze([
  'activity',
  'interaction',
  'random',
  'participants',
  'medium',
  'topic',
]);

export const VALUES = Object.freeze({
  activity: ['跑团', '开发', '调试', '测试', '文档', '对话', '其他'],
  interaction: ['回合制', '指令式', '自由对话', '无'],
  random: ['有', '无'],
  participants: ['单人', '多人', '协作', '对抗', '无'],
  medium: ['文字', '代码', '图像', '语音', '无'],
  topic: ['剧情', '技术', '设备', '记忆', '规则', '其他'],
});

/** Query aliases are cached expansions, not identities. */
export const DEFAULT_ALIASES = Object.freeze({
  // Aliases are retrieval anchors, not full identity bundles. Keep them
  // minimal: a maximal bundle makes every technical turn match 开发 and 调试.
  跑团: { activity: '跑团' },
  开发: { activity: '开发' },
  调试: { activity: '调试' },
  测试: { activity: '测试' },
  记忆: { topic: '记忆' },
  规则: { topic: '规则' },
  图像: { topic: '设备', medium: '图像' },
  技术: { topic: '技术' },
  TRPG: { activity: '跑团' },
  掷骰子: { activity: '跑团' },
  角色扮演: { activity: '跑团' },
  头像: { topic: '设备', medium: '图像' },
  立绘: { topic: '设备', medium: '图像' },
  记忆宫殿: { topic: '记忆' },
});

export function facetKey(slot, value) {
  return `${slot}:${value}`;
}

export function isKnownFacet(slot, value) {
  return SLOTS.includes(slot) && Array.isArray(VALUES[slot]) && VALUES[slot].includes(value);
}

export function normalizeFacets(input) {
  const out = {};
  if (Array.isArray(input)) {
    for (const item of input) {
      const [slot, ...rest] = String(item).split(':');
      const value = rest.join(':').trim();
      if (isKnownFacet(slot, value)) out[slot] = value;
    }
  } else if (input !== null && typeof input === 'object') {
    for (const slot of SLOTS) {
      const value = input[slot];
      if (isKnownFacet(slot, value)) out[slot] = value;
    }
  }
  return out;
}

export function aliasFacets(alias) {
  return normalizeFacets(DEFAULT_ALIASES[String(alias ?? '').trim()] ?? {});
}
