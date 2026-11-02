/**
 * System-side memory load gate.
 *
 * The gate decides whether to load prior context before the model speaks.
 * It does not ask the LLM for approval. The LLM may still call memory.load
 * manually; that is an optional second path, not the gate.
 */

const META_PATTERN = /TAG\s*:|戏外|存档|回执|折叠|gist|```|未决|threads|session/i;
const META_MENTION = /这个设计|这个机制|挺有意思|是什么|怎么写|规则文档|文档里/u;

export function isSceneRecord(record) {
  return record?.facets?.medium !== '代码' && !META_PATTERN.test(record?.text ?? '');
}

function hasActivitySignal(text, activity) {
  const source = String(text ?? '');
  if (source.trim().length < 2) return false;
  if (activity === '跑团') return /跑团|TRPG|开团|骰|团|灯室|钟楼|矿口|角色|剧情/u.test(source);
  if (activity === '开发' || activity === '调试' || activity === '文档' || activity === '测试') {
    return /代码|插件|接口|调试|文档|版本|测试|部署|修|改|实现|bug/iu.test(source);
  }
  if (activity === '对话') return /聊|说|想|问|讨论/u.test(source);
  return source.trim().length >= 8;
}

export class MemoryLoadState {
  constructor({
    loadedFacets = null,
    loadedSeq = null,
    loadedAtTurn = null,
    lastReason = null,
    cooldownTurns = 8,
    autoActivityLoad = false,
    abstainThreshold = 0.5,
  } = {}) {
    this.loadedFacets = loadedFacets;
    this.loadedSeq = loadedSeq;
    this.loadedAtTurn = loadedAtTurn;
    this.lastReason = lastReason;
    this.cooldownTurns = cooldownTurns;
    this.autoActivityLoad = autoActivityLoad;
    this.abstainThreshold = abstainThreshold;
  }

  decide({ text, currentFacets, confidence = 1, nowTurn = 0, hasCandidate = true, candidate = null, role = 'user', boundaryScore = null }) {
    if (role === 'assistant') return { action: 'none', reason: 'assistant-text' };
    const facets = currentFacets ?? {};
    const activity = facets.activity ?? null;
    if (activity === null) return { action: 'none', reason: 'no-activity' };
    if (confidence < this.abstainThreshold) return { action: 'none', reason: 'low-confidence' };

    const recall = /上次|之前(?:那个|那件|那次|说的|聊的|提的|发生)|还记得|后来|上一次|刚才|交给谁|在哪|发生了什么|最后(?:呢|怎么|怎么样|是谁|多少|哪|结果)/u.test(text);
    const start = /开始(?:跑团|一局|团|游戏|新的)|开个新团|新团|开新团|来一局|开团|开一局|进入.*(?:跑团|灯室|游戏)|跑团吧|TRPG/u.test(text);
    const activityChanged = this.loadedFacets !== null && this.loadedFacets.activity !== activity;
    const topicChanged = this.loadedFacets !== null
      && this.loadedFacets.activity === activity
      && this.loadedFacets.topic !== facets.topic;
    const entity = /[\u4e00-\u9fff]{2,}|[a-z][a-z0-9_-]{2,}/iu.test(text);
    const cooldown = this.loadedAtTurn !== null && nowTurn - this.loadedAtTurn < this.cooldownTurns;
    const hasBoundary = Number.isFinite(boundaryScore);
    const strongBoundary = hasBoundary && boundaryScore >= 0.35;

    if (recall) {
      if (!hasCandidate) return { action: 'none', reason: 'recall-no-candidate' };
      return { action: 'load', reason: 'explicit-recall', query: text, facets, candidate };
    }

    if (start) {
      if (!hasCandidate) return { action: 'none', reason: 'start-no-candidate' };
      return { action: 'load', reason: 'explicit-start', query: text, facets, candidate };
    }

    if (META_MENTION.test(text)) {
      return { action: 'none', reason: 'meta-mention' };
    }

    if (this.loadedFacets === null) {
      if (hasCandidate && confidence >= 0.75) {
        return { action: 'load', reason: 'initial-context', query: activity, facets, candidate };
      }
      return { action: 'none', reason: 'initial-low-confidence' };
    }

    if (strongBoundary) {
      if (!hasCandidate) return { action: 'none', reason: 'boundary-no-candidate' };
      const autoBoundary = this.autoActivityLoad || role === 'peer';
      if (!autoBoundary) {
        return { action: 'hint', reason: 'boundary-hint', query: text, facets, candidate };
      }
      if (cooldown && confidence < 0.85) return { action: 'none', reason: 'cooldown' };
      return { action: 'load', reason: 'boundary-change', query: text, facets, candidate };
    }

    if (hasBoundary && !strongBoundary) {
      if (boundaryScore > 0 && activityChanged) {
        if (!hasActivitySignal(text, activity)) return { action: 'none', reason: 'no-activity-signal' };
        if (role === 'peer' || this.autoActivityLoad) {
          return { action: 'load', reason: 'activity-change', query: activity, facets, candidate };
        }
        return { action: 'hint', reason: 'activity-change-hint', query: activity, facets, candidate };
      }
      return { action: 'none', reason: 'weak-boundary' };
    }

    if (activityChanged) {
      if (!hasCandidate) return { action: 'none', reason: 'activity-no-candidate' };
      if (!hasActivitySignal(text, activity)) return { action: 'none', reason: 'no-activity-signal' };
      const autoActivity = this.autoActivityLoad || role === 'peer';
      if (!autoActivity) {
        return { action: 'hint', reason: 'activity-change-hint', query: activity, facets, candidate };
      }
      if (cooldown && confidence < 0.85) return { action: 'none', reason: 'cooldown' };
      return { action: 'load', reason: 'activity-change', query: activity, facets, candidate };
    }

    if (topicChanged && entity) {
      return { action: 'hint', reason: 'topic-entity', query: text, facets, candidate };
    }

    return { action: 'none', reason: 'same-context' };
  }

  recordLoad({ facets, seq = null, nowTurn = 0, reason = null }) {
    this.loadedFacets = facets ?? this.loadedFacets;
    this.loadedSeq = seq;
    this.loadedAtTurn = nowTurn;
    this.lastReason = reason;
    return this;
  }
}

export function latestCandidate(records, facet, value, { sceneOnly = true } = {}) {
  const hits = records.filter((record) => record.facets?.[facet] === value);
  if (hits.length === 0) return null;
  if (sceneOnly) {
    const scenes = hits.filter(isSceneRecord);
    return scenes.length === 0 ? null : scenes[scenes.length - 1];
  }
  return hits[hits.length - 1];
}

export function candidateSegment(records, candidate, { sceneOnly = true } = {}) {
  if (candidate === null) return null;
  const activity = candidate.facets?.activity;
  const index = records.findIndex((record) => record.turn === candidate.turn);
  if (index < 0) return null;
  let start = index;
  let end = index;
  const fits = (record) => record.facets?.activity === activity && (!sceneOnly || isSceneRecord(record));
  while (start > 0 && fits(records[start - 1])) start -= 1;
  while (end + 1 < records.length && fits(records[end + 1])) end += 1;
  const segment = records.slice(start, end + 1);
  return {
    turn: candidate.turn,
    seqStart: segment[0].seqStart,
    seqEnd: segment[segment.length - 1].seqEnd,
    turns: segment.length,
    text: segment.map((record) => record.text).join('\n'),
  };
}
