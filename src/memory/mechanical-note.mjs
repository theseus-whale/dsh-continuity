/**
 * Deterministic handoff note for the 4.13 mechanical-summary trial.
 *
 * The note is a rendered record, not an LLM summary: user text, tool calls and
 * tool receipts are kept; assistant prose and reasoning are skipped. It is
 * deliberately boring so a fold cannot silently lose the record's shape.
 */

const DEFAULT_MAX_TOKENS = 32_000;
const CHARS_PER_TOKEN = 4;
const INJECTED = /^(?:\[(?:continuity:|追忆|抽取|工作线|标签|规则|规矩|习惯|技能|归位|候选|存\?|闸|回正|学习|记忆)|<system-reminder>|Current runtime context|Time sampled while preparing)/i;
const PEER = /^\[(?:创|peer)\]/i;

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && typeof block === 'object' && block.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join('\n');
}

function toolCallsOf(message) {
  const calls = [];
  if (Array.isArray(message?.tool_calls)) {
    for (const call of message.tool_calls) {
      const name = call?.function?.name ?? call?.name;
      if (typeof name === 'string') calls.push({ name, args: call?.function?.arguments ?? call?.arguments ?? '' });
    }
  }
  if (Array.isArray(message?.content)) {
    for (const block of message.content) {
      if (block?.type === 'tool-call' || block?.type === 'tool_call') {
        const name = block?.name ?? block?.toolName;
        if (typeof name === 'string') calls.push({ name, args: block?.arguments ?? block?.input ?? '' });
      }
    }
  }
  return calls;
}

function oneLine(text, maxChars) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars).replace(/\s+\S*$/, '')}…`;
}

function normalize(args) {
  if (typeof args === 'string') return args;
  try { return JSON.stringify(args ?? {}); } catch { return String(args ?? ''); }
}

export function renderMechanicalNote({
  messages,
  maxTokens = DEFAULT_MAX_TOKENS,
  header = null,
}) {
  const list = Array.isArray(messages) ? messages : [];
  const lines = [];
  const budgetChars = Math.max(400, Number(maxTokens) || DEFAULT_MAX_TOKENS) * CHARS_PER_TOKEN;

  if (typeof header === 'string' && header.trim().length > 0) lines.push(header.trim());
  lines.push('## Mechanical handoff note');
  lines.push('This is a mechanical record of the folded range. It is not an LLM summary; raw session_log remains authoritative.');

  for (const message of list) {
    const role = String(message?.role ?? '');
    if (role === 'system') continue;
    if (role === 'user') {
      const text = textOfContent(message?.content).trim();
      if (!text || INJECTED.test(text)) continue;
      if (PEER.test(text)) {
        lines.push(`## Peer\n${oneLine(text, 8_000)}`);
      } else {
        lines.push(`## User\n${oneLine(text, 12_000)}`);
      }
      continue;
    }
    if (role === 'assistant') {
      for (const call of toolCallsOf(message)) {
        lines.push(`## Tool call\n${call.name} ${oneLine(normalize(call.args), 2_000)}`);
      }
      continue;
    }
    if (role === 'tool') {
      const text = textOfContent(message?.content).trim();
      if (text) lines.push(`## Tool receipt\n${oneLine(text, 6_000)}`);
    }
  }

  let text = lines.join('\n\n');
  if (text.length > budgetChars) {
    text = `${text.slice(-budgetChars).replace(/^\s+\S*/, '')}`;
    text = `## Mechanical handoff note\n(older entries trimmed)\n\n${text}`;
  }
  return {
    text,
    chars: text.length,
    approxTokens: Math.ceil(text.length / CHARS_PER_TOKEN),
    maxTokens,
  };
}

export default renderMechanicalNote;
