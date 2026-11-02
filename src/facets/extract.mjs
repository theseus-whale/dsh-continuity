/**
 * Rule-based fallback extractor for facet MVP.
 *
 * This is intentionally not an LLM. It gives the index/query path something
 * runnable before a local ONNX classifier is added. Missing slots stay missing;
 * they are not guessed.
 */
import { SLOTS, VALUES, normalizeFacets } from './schema.mjs';

const LEXICON = {
  activity: {
    跑团: ['跑团', '掷骰', '骰子', 'D20', '角色卡', '检定', 'KP', '守渡人', '剧情推进'],
    开发: ['开发', '实现', '写代码', '补丁', '插件', '接口'],
    调试: ['调试', '排查', '探针', '日志', '报错', '崩溃'],
    测试: ['测试', '自检', '验收', '用例', '回归'],
    文档: ['文档', '手册', '说明', 'README', '写文档'],
    对话: ['对话', '聊天', '你觉得', '感受', '关系'],
  },
  interaction: {
    回合制: ['回合', '轮到我', '下一回合', '行动', '掷骰'],
    指令式: ['命令', '执行', '运行', '工具', '脚本'],
    自由对话: ['聊天', '对话', '问', '回答'],
  },
  random: {
    有: ['掷骰', '骰子', 'D20', '随机', '概率', '检定'],
    无: [],
  },
  participants: {
    单人: ['单人', '我自己', '独自'],
    多人: ['多人'],
    协作: ['协作', '一起', '帮我', '我们', '配合'],
    对抗: ['对抗', '敌人', '战斗'],
  },
  medium: {
    文字: ['文字', '正文', '文本', '故事'],
    代码: ['代码', '函数', '源码', '脚本'],
    图像: ['图片', '头像', '画图', '图像'],
    语音: ['语音', '口述'],
  },
  topic: {
    剧情: ['剧情', '故事', '角色', '场景', '任务'],
    技术: ['技术', '代码', '插件', '系统', '接口'],
    设备: ['设备', '手机', '电脑', '硬件'],
    记忆: ['记忆', '回忆', '上下文', '线头'],
    规则: ['规则', '判据', '阈值', '闸', '约束'],
  },
};

function scoreSlot(text, slot) {
  const values = LEXICON[slot] ?? {};
  let best = null;
  for (const [value, words] of Object.entries(values)) {
    if (!VALUES[slot].includes(value)) continue;
    let score = 0;
    for (const word of words) {
      if (text.includes(word)) score += 1;
    }
    if (score > 0 && (best === null || score > best.score)) best = { value, score };
  }
  return best;
}

export function extractFacets(text) {
  const source = String(text ?? '');
  const facets = {};
  const evidence = {};
  for (const slot of SLOTS) {
    const hit = scoreSlot(source, slot);
    if (hit !== null) {
      facets[slot] = hit.value;
      evidence[slot] = hit.score;
    }
  }
  // random is binary: if the text has no random signal, it is not guessed here.
  return {
    facets: normalizeFacets(facets),
    evidence,
    unknown: Object.keys(facets).length === 0,
  };
}
