/**
 * B-layer labeling: frozen embedding + generic concept descriptions.
 *
 * No LLM, no network, no writes. One BGE load can label many texts.
 */
import { GENERIC_CONCEPTS } from './bc-recall.mjs';

export const GENERIC_LABELS = Object.freeze({
  游戏: '游戏、桌游、跑团、角色扮演、掷骰、回合制',
  故事: '故事、剧情、叙事、角色、对白、场景',
  对话: '对话、聊天、讨论、交流',
  技术: '技术、代码、程序、系统、开发、调试',
  设备: '设备、硬件、机器、工具、图像',
  规则: '规则、规定、制度、约束、流程',
  记忆: '记忆、回忆、历史、上下文、连续性',
  剧情: '剧情、情节、故事发展、角色行动',
  病毒: '病毒、传染病、疫情、病原体、公共卫生',
  公共卫生: '公共卫生、防疫、传播、疾病控制',
  科学: '科学、研究、实验、论文、证据',
});

function normalizeVector(vector) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

function cosine(a, b) {
  let dot = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) dot += a[index] * b[index];
  return dot;
}

export function createBLabeler({ embed = null, concepts = GENERIC_CONCEPTS, labels = GENERIC_LABELS, kinds = null } = {}) {
  if (typeof embed !== 'function') throw new Error('B labeler needs an embed function');
  let ready = null;
  const names = concepts.filter((concept) => labels[concept]);
  const split = kinds !== null && typeof kinds === 'object' && Object.keys(kinds).length > 0;
  const kindOf = (concept) => (kinds?.[concept] === 'workflow' ? 'workflow' : 'topic');
  // topicConfidence is a display label; 0.4/0.5 are not write thresholds.
  const confidenceOf = (score) => (score >= 0.5 ? 'normal' : score >= 0.4 ? 'low' : 'weak');
  async function prepare() {
    if (ready !== null) return ready;
    const vectors = names.length > 0 ? await embed(names.map((concept) => labels[concept])) : [];
    ready = { labels: names, vectors: vectors.map(normalizeVector) };
    return ready;
  }
  return {
    async label(text, { topK = 3, minScore = 0.25, topicMinScore = 0.33, topicTopK = 1, workflowTopK = 2 } = {}) {
      const prepared = await prepare();
      const [rawVector] = await embed([String(text ?? '')]);
      const vector = normalizeVector(rawVector);
      if (prepared.labels.length === 0) {
        return { candidates: [], unknown: true, top: null, vector, ...(split ? { version: 2, topic: [], workflow: [], scores: {} } : {}) };
      }
      const scored = prepared.labels.map((concept, index) => ({
        concept,
        score: cosine(vector, prepared.vectors[index]),
      })).sort((a, b) => b.score - a.score);

      if (split) {
        const topic = scored.find((item) => kindOf(item.concept) === 'topic' && item.score >= topicMinScore);
        const topicCandidates = topic === undefined ? [] : [topic];
        const workflow = scored
          .filter((item) => kindOf(item.concept) === 'workflow' && item.score >= minScore)
          .slice(0, workflowTopK);
        const candidates = [...topicCandidates, ...workflow].sort((a, b) => b.score - a.score).slice(0, 1 + workflowTopK);
        const scores = Object.fromEntries([...topicCandidates, ...workflow].map((item) => [item.concept, item.score]));
        return {
          candidates,
          topic: topicCandidates,
          workflow,
          scores,
          topicScore: topic?.score ?? null,
          topicConfidence: topic ? confidenceOf(topic.score) : null,
          topicMinScore,
          unknown: candidates.length === 0,
          top: topic ?? workflow[0] ?? null,
          vector,
          version: 2,
        };
      }

      const candidates = scored.filter((item) => item.score >= minScore).slice(0, topK);
      return {
        candidates,
        unknown: candidates.length === 0 || candidates[0].score < minScore,
        top: candidates[0] ?? null,
        vector,
      };
    },
  };
}
