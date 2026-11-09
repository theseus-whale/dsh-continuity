/**
 * Deterministic window summary.
 *
 * This is the fallback generator for a pending archive window when no
 * compaction/checkpoint summary exists. It is deliberately structural, not a
 * replacement for an LLM summary: it preserves who said/did what and where the
 * raw seqs are, so a later model pass can replace the body without changing the
 * carrier contract.
 */
import { createHash } from 'node:crypto';

const DEFAULT_MAX_TOKENS = 800;
const CHARS_PER_TOKEN = 4;
const INJECTED = /^(?:\[(?:continuity:|追忆|抽取|工作线|标签|规则|规矩|习惯|技能|归位|候选|存\?|闸|回正|学习|记忆)|<system-reminder>|Current runtime context|Time sampled while preparing)/i;
const PEER = /^\[(?:创|peer)\]/i;

function textOf(event) {
  const data = event?.data ?? {};
  const blocks = data?.message?.content ?? data?.content ?? [];
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => block && typeof block === 'object' && block.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join('\n');
}

function oneLine(text, maxChars) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars).replace(/\s+\S*$/, '')}…`;
}

function toolNames(event) {
  const data = event?.data ?? {};
  const name = data?.name ?? data?.toolName ?? data?.message?.name;
  return typeof name === 'string' && name.length > 0 ? name : null;
}

export function buildWindowSummary({
  events,
  fromSeq,
  toSeq,
  maxTokens = DEFAULT_MAX_TOKENS,
}) {
  const from = Math.min(Number(fromSeq), Number(toSeq));
  const to = Math.max(Number(fromSeq), Number(toSeq));
  const list = (Array.isArray(events) ? events : [])
    .filter((event) => {
      const seq = Number(event?.seq);
      return Number.isInteger(seq) && seq >= from && seq <= to;
    })
    .sort((a, b) => Number(a.seq) - Number(b.seq));

  const users = [];
  const peers = [];
  const assistants = [];
  const tools = [];
  for (const event of list) {
    if (event?.type === 'user/message') {
      const text = textOf(event).trim();
      if (text.length === 0 || INJECTED.test(text)) continue;
      if (PEER.test(text)) peers.push(event);
      else users.push(event);
    } else if (event?.type === 'assistant/message') {
      if (textOf(event).trim().length > 0) assistants.push(event);
    } else if (event?.type === 'tool/call') {
      const name = toolNames(event);
      if (name !== null) tools.push(name);
    }
  }

  const lines = [];
  lines.push(`## 窗口 seq ${from}-${to}`);
  lines.push(`事件 ${list.length} · 用户 ${users.length} · 同伴 ${peers.length} · 助手 ${assistants.length} · 工具 ${tools.length}`);

  const pickedUsers = users.length <= 4
    ? users
    : [...users.slice(0, 2), ...users.slice(-2)];
  const pickedPeers = peers.length <= 4
    ? peers
    : [...peers.slice(0, 2), ...peers.slice(-2)];
  const pickedAssistants = assistants.length <= 4
    ? assistants
    : [...assistants.slice(0, 2), ...assistants.slice(-2)];

  if (pickedUsers.length > 0) {
    lines.push('## 用户');
    for (const event of pickedUsers) {
      const text = oneLine(textOf(event), 220);
      if (text.length > 0) lines.push(`- seq ${event.seq}: ${text}`);
    }
  }
  if (pickedPeers.length > 0) {
    lines.push('## 同伴');
    for (const event of pickedPeers) {
      const text = oneLine(textOf(event), 220);
      if (text.length > 0) lines.push(`- (peer) seq ${event.seq}: ${text}`);
    }
  }
  if (pickedAssistants.length > 0) {
    lines.push('## 助手');
    for (const event of pickedAssistants) {
      const text = oneLine(textOf(event), 220);
      if (text.length > 0) lines.push(`- seq ${event.seq}: ${text}`);
    }
  }
  const uniqueTools = [...new Set(tools)];
  if (uniqueTools.length > 0) {
    lines.push('## 工具');
    lines.push(uniqueTools.slice(0, 12).join(', '));
  }
  lines.push('## 指针');
  lines.push(`本窗口 raw 首尾：${from}..${to}；细节按 seq 回 session_log 取。`);

  let text = lines.join('\n');
  const capChars = Math.max(400, maxTokens) * CHARS_PER_TOKEN;
  if (text.length > capChars) {
    text = `${text.slice(0, capChars).replace(/\s+\S*$/, '')}…`;
  }
  const approxTokens = Math.ceil(text.length / CHARS_PER_TOKEN);
  return {
    fromSeq: from,
    toSeq: to,
    text,
    chars: text.length,
    approxTokens,
    hash: createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16),
    kind: 'window-extractive',
    quality: list.length > 1000 && approxTokens < 400 ? 'extractive-thin' : 'extractive',
  };
}

export default buildWindowSummary;
