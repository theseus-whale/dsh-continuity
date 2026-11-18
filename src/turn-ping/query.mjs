const MACHINE_PREFIX = /^(?:Current runtime context|Current working directory|Current DSH file policy|Approval prompts|Time sampled|Browser time zone|\[(?:抽取|工作线|标签|规则|习惯|技能|归位|候选|存\?|闸|回正|学习|追忆|记忆|continuity:[a-z-]+)\])/;

function sourceOf(message) {
  return message?.source ?? message?.data?.source ?? null;
}

export function normalizeTurnPingUserMessage(message) {
  if (message?.role !== 'user') return message;
  const source = sourceOf(message);
  if (source?.peer === true) {
    return {
      ...message,
      source: {
        ...source,
        kind: 'user',
        peer: false,
        peerFrom: source.peerFrom ?? source.from ?? null,
      },
    };
  }
  return message;
}

function textOf(message) {
  if (message?.role !== 'user') return '';
  const source = sourceOf(message);
  const kind = source?.kind ?? null;
  const peer = source?.peer === true;
  if (kind !== null && kind !== 'user' && kind !== 'peer') return '';
  const content = message.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) text = content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
  if (!text.trim()) return '';
  if (MACHINE_PREFIX.test(text.trimStart())) return '';
  return text.trim();
}

/** Turn-ping-only query extraction. Does not weaken the legacy extraction filter. */
export function turnPingUserText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = textOf(messages[index]);
    if (text) return text;
  }
  return '';
}

export function normalizeTurnPingQueryMessages(messages = []) {
  return messages.map((message) => normalizeTurnPingUserMessage(message));
}

export function turnPingQueryInfo(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const text = textOf(message);
    if (!text) continue;
    const source = sourceOf(message);
    return {
      text,
      message,
      sourceKind: source?.kind ?? null,
      sourcePeer: source?.peer === true,
      peerFrom: source?.peerFrom ?? null,
      normalized: normalizeTurnPingUserMessage(message),
    };
  }
  return { text: '', message: null, sourceKind: null, sourcePeer: false, peerFrom: null, normalized: null };
}
