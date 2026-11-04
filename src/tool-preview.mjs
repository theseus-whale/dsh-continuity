/**
 * Pure A4/B helpers: active-tool pinning and deterministic tool-result previews.
 *
 * A4 keeps a hard pin on the tools of the current open turn (plus every
 * unpaired call). All other `tool/result` nodes may be rewritten to a head +
 * marker + tail preview; user/assistant/reasoning content is never touched.
 * The marker cites the original seq so `session_log get seq=<n>` can recover
 * the full text; the raw log is never rewritten.
 *
 * No DSH imports: the engine supplies live events and the token meter.
 */

const DEFAULTS = Object.freeze({
  maxChars: 1280,
  headChars: 900,
  tailChars: 200,
});

/** Recursively freeze a freshly built message tree. */
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/** Count Unicode code points without splitting a surrogate pair. */
export function codePointLength(text) {
  return Array.from(String(text ?? '')).length;
}

function textOfBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  let text = '';
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') return null;
    if (block.type !== 'text' || typeof block.text !== 'string') return null;
    text += block.text;
  }
  return text;
}

/**
 * Build a preview for a text-only block array.
 * @param {readonly object[]} blocks
 * @param {{ maxChars?: number, headChars?: number, tailChars?: number, originalSeq?: number|string|null, header?: string|null }} [options]
 * @returns {{ content: object[], charsBefore: number, charsAfter: number, omitted: number, marker: string } | null}
 */
export function previewBlocks(blocks, options = {}) {
  const maxChars = Number.isInteger(options.maxChars) ? options.maxChars : DEFAULTS.maxChars;
  const headChars = Number.isInteger(options.headChars) ? options.headChars : DEFAULTS.headChars;
  const tailChars = Number.isInteger(options.tailChars) ? options.tailChars : DEFAULTS.tailChars;
  const text = textOfBlocks(blocks);
  if (text === null) return null;

  const points = Array.from(text);
  if (points.length <= maxChars) return null;
  if (headChars < 0 || tailChars < 0 || headChars + tailChars >= points.length) return null;

  const head = points.slice(0, headChars).join('');
  const tail = points.slice(-tailChars).join('');
  const omitted = points.length - headChars - tailChars;
  const where = options.originalSeq === undefined || options.originalSeq === null
    ? (options.header ? `original retrievable via ${options.header}` : 'original retrievable via session_log get on the gist range')
    : `original retrievable via session_log get seq=${options.originalSeq}`;
  const marker = `\n\n[... tool result preview: omitted ${omitted} chars; ${where} ...]\n\n`;
  const content = [{ type: 'text', text: head + marker + tail }];
  return {
    content,
    charsBefore: points.length,
    charsAfter: codePointLength(content[0].text),
    omitted,
    marker,
  };
}

/**
 * A handle, a pause, or an existing preview must never be previewed again: a
 * second pass would cut the semantic summary/path and repoint the marker at the
 * handle's own replacement seq instead of the original non-text event.
 * @param {readonly object[]} blocks
 * @returns {boolean}
 */
export function isNonPreviewableBlocks(blocks) {
  if (!Array.isArray(blocks)) return false;
  const text = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
  return text.includes('[tool result handle')
    || text.includes('[continuity pause')
    || text.includes('[... tool result preview');
}

/**
 * Rewrite one tool/result event into a preview message.
 * @param {object} event
 * @param {number|string} seq
 * @param {object} [options]
 * @returns {{ message: object, charsBefore: number, charsAfter: number, omitted: number, marker: string, seq: number|string } | null}
 */
export function previewToolResultEvent(event, seq, options = {}) {
  if (event?.type !== 'tool/result') return null;
  const message = event?.data?.message;
  if (message === undefined || message === null) return null;
  if (isNonPreviewableBlocks(message.content)) return null;
  const preview = previewBlocks(message.content, { ...options, originalSeq: seq });
  if (preview === null) return null;
  return {
    ...preview,
    seq,
    message: deepFreeze({ ...message, content: preview.content }),
  };
}

/**
 * Copy a summarization input with tool-result messages previewed. Human,
 * assistant and reasoning messages are returned unchanged.
 * @param {object} input
 * @param {{ maxChars?: number, headChars?: number, tailChars?: number, header?: string|null }} [options]
 */
export function previewSummaryInput(input, options = {}) {
  if (input === null || typeof input !== 'object' || !Array.isArray(input.messages)) return input;
  let changed = false;
  const messages = input.messages.map((message) => {
    if (message?.role !== 'tool' || isNonPreviewableBlocks(message.content)) return message;
    const preview = previewBlocks(message.content, {
      maxChars: options.maxChars,
      headChars: options.headChars,
      tailChars: options.tailChars,
      header: options.header ?? null,
    });
    if (preview === null) return message;
    changed = true;
    return deepFreeze({ ...message, content: preview.content });
  });
  return changed ? { ...input, messages } : input;
}

/**
 * Call ids that are active at compaction time: every tool call in the current
 * open turn, plus every unpaired call in the last `recentTurns` turns. Older
 * unmatched calls are abandoned project debris, not active work.
 * @param {readonly object[]} events full session log in seq order
 * @param {{ recentTurns?: number }} [options]
 * @returns {Set<string>}
 */
export function activeCallIds(events, { recentTurns = 3 } = {}) {
  if (!Array.isArray(events)) return new Set();
  let openTurn = null;
  const completed = new Set();
  const turns = [];
  for (const event of events) {
    if (event?.type === 'turn/start') {
      openTurn = event.data?.turn ?? null;
      if (!turns.includes(openTurn)) turns.push(openTurn);
    } else if (event?.type === 'turn/end' && event.data?.turn === openTurn) {
      openTurn = null;
    } else if (event?.type === 'tool/result') {
      const callId = event.data?.message?.source?.callId ?? event.data?.message?.toolCallId;
      if (callId !== undefined && callId !== null) completed.add(String(callId));
    }
  }

  const keep = Math.max(1, Math.trunc(Number(recentTurns) || 3));
  const recent = new Set(turns.slice(-keep));
  const active = new Set();
  for (const event of events) {
    if (event?.type !== 'tool/call') continue;
    const callId = event.data?.callId;
    if (callId === undefined || callId === null) continue;
    const inOpenTurn = openTurn !== null && event.data?.turn === openTurn;
    const recentUnpaired = recent.has(event.data?.turn) && !completed.has(String(callId));
    if (inOpenTurn || recentUnpaired) active.add(String(callId));
  }
  return active;
}

/** Surface seqs holding an active assistant tool-call message or its result. */
export function activePinSeqs(surfaceSeqs, eventAt, callIds) {
  const pins = new Set();
  if (!Array.isArray(surfaceSeqs) || callIds === undefined || callIds === null || callIds.size === 0) return pins;
  for (const seq of surfaceSeqs) {
    const event = eventAt(seq);
    if (event?.type === 'tool/result') {
      const callId = event.data?.message?.source?.callId ?? event.data?.message?.toolCallId;
      if (callId !== undefined && callId !== null && callIds.has(String(callId))) pins.add(seq);
    } else if (event?.type === 'assistant/message') {
      const content = event.data?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === 'tool-call' && block.id !== undefined && callIds.has(String(block.id))) {
          pins.add(seq);
          break;
        }
      }
    }
  }
  return pins;
}

/** Index of the oldest active pin, or -1. */
export function oldestPinIndex(surfaceSeqs, pins) {
  if (!Array.isArray(surfaceSeqs) || pins === undefined || pins === null || pins.size === 0) return -1;
  for (let index = 0; index < surfaceSeqs.length; index += 1) {
    if (pins.has(surfaceSeqs[index])) return index;
  }
  return -1;
}

/**
 * The post-compression target for a triggered plan. A4 always drives a
 * band-high trigger to `low` and an emergency trigger to `emergencyTo`; it does
 * not treat `high` as the target (that would leave the context hovering at the
 * trigger and cause repeated prefix invalidations).
 * @param {'band-high'|'emergency'|string} reason
 * @param {{ low?: number, emergencyTo?: number }} policy
 * @returns {number|null}
 */
export function targetFractionFor(reason, policy) {
  if (reason === 'emergency') {
    return Number.isFinite(policy?.emergencyTo) ? policy.emergencyTo : null;
  }
  if (reason === 'band-high') {
    return Number.isFinite(policy?.low) ? policy.low : null;
  }
  return null;
}

/**
 * Remaining pass budget after the preview stage. `band-high` keeps the normal
 * `maxPerBatch` cap; `emergency` ignores it, as the policy does. A positive
 * budget here means the pass must continue to the target even if the preview
 * already brought the estimate below `high`.
 * @param {{ reason: string, estTokens: number, windowTokens: number, policy: object }} input
 * @returns {number} 0 when no pass is needed
 */
export function compressionBudget({ reason, estTokens, windowTokens, policy }) {
  const target = targetFractionFor(reason, policy);
  if (target === null) return 0;
  if (!Number.isFinite(estTokens) || !Number.isFinite(windowTokens) || windowTokens <= 0) return 0;
  const remaining = estTokens - target * windowTokens;
  if (!(remaining > 0)) return 0;
  if (reason === 'emergency') return remaining;
  const minAction = Number.isFinite(policy?.minAction) ? policy.minAction : 0;
  if (remaining < minAction) return 0;
  const cap = policy?.maxPerBatch;
  return Number.isFinite(cap) ? Math.min(remaining, cap) : remaining;
}

/** Map tool call id → { name, arguments, turn } from the raw log. */
export function toolCallMap(events) {
  const map = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'tool/call') continue;
    const callId = event.data?.callId;
    if (callId === undefined || callId === null) continue;
    map.set(String(callId), {
      name: String(event.data?.name ?? 'tool'),
      arguments: String(event.data?.arguments ?? ''),
      turn: event.data?.turn,
    });
  }
  return map;
}

const NON_TEXT_TYPES = new Set(['image', 'file', 'audio', 'video']);
export const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * Describe non-text blocks without carrying their payload. Returns null for a
 * text-only tool result.
 * @param {object} event
 * @returns {{ types: string[], names: string[], bytes: number|null, text: string, isError: boolean } | null}
 */
export function nonTextInfo(event) {
  if (event?.type !== 'tool/result') return null;
  const content = event.data?.message?.content;
  if (!Array.isArray(content)) return null;
  const types = [];
  const names = [];
  const paths = [];
  let bytes = null;
  const texts = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
    } else if (block?.type !== undefined && NON_TEXT_TYPES.has(block.type)) {
      if (!types.includes(block.type)) types.push(block.type);
      const name = block.attachment?.name ?? block.name ?? block.fileName ?? block.source?.name;
      if (typeof name === 'string' && name.length > 0 && !names.includes(name)) names.push(name);
      const path = block.attachment?.path ?? block.path ?? block.source?.path;
      if (typeof path === 'string' && path.length > 0 && !paths.includes(path)) paths.push(path);
      const size = block.attachment?.size ?? block.size ?? block.bytes;
      if (Number.isFinite(size)) bytes = (bytes ?? 0) + size;
      else {
        const data = block.source?.data ?? block.data ?? block.base64;
        if (typeof data === 'string' && data.length > 0) {
          bytes = (bytes ?? 0) + Math.floor((data.length * 3) / 4);
        }
      }
    }
  }
  if (types.length === 0) return null;
  return {
    types,
    names,
    paths,
    bytes,
    text: texts.join('\n').trim(),
    isError: event.data?.message?.isError === true,
  };
}

/** Images stay in the model context; other non-text result types use handles. */
export function isImageToolResult(event) {
  const info = nonTextInfo(event);
  return info !== null
    && info.types.includes('image')
    && info.bytes !== null
    && info.bytes <= MAX_INLINE_IMAGE_BYTES;
}

function argsPreview(args) {
  return String(args ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

/**
 * Build a text handle for a non-text tool result. The original raw event stays
 * untouched; the handle is the model-visible replacement.
 * @param {object} event
 * @param {number|string} seq
 * @param {{ toolName?: string, toolArgs?: string, semantic?: object|null }} [options]
 */
export function handleNonTextToolResult(event, seq, options = {}) {
  const info = nonTextInfo(event);
  if (info === null) return null;
  const semantic = options.semantic ?? {};
  const toolName = options.toolName ?? 'tool';
  const args = argsPreview(options.toolArgs);
  const importance = typeof semantic.importance === 'string' && semantic.importance.length > 0
    ? semantic.importance
    : (info.isError ? 'high (error)' : 'unknown');
  const summary = typeof semantic.summary === 'string' && semantic.summary.trim().length > 0
    ? semantic.summary.trim().slice(0, 800)
    : (info.text.length > 0 ? info.text.slice(0, 300) : 'no semantic summary; inspect the original if needed');
  const topic = typeof semantic.topic === 'string' && semantic.topic.trim().length > 0
    ? semantic.topic.trim().slice(0, 200)
    : `${toolName}${args.length > 0 ? ` ${args}` : ''}`;
  const fn = typeof semantic.function === 'string' && semantic.function.trim().length > 0
    ? semantic.function.trim().slice(0, 200)
    : `${toolName} returned ${info.types.join('/')} output`;
  const caveats = typeof semantic.caveats === 'string' && semantic.caveats.trim().length > 0
    ? semantic.caveats.trim().slice(0, 300)
    : 'non-text payload not loaded; original archived';
  const callId = event.data?.message?.source?.callId ?? event.data?.message?.toolCallId ?? '?';
  const names = info.names.length > 0 ? info.names.join(', ') : 'unnamed';
  const paths = info.paths.length > 0 ? info.paths.join(', ') : '';
  const bytes = info.bytes === null ? '?' : String(info.bytes);
  const text = [
    `[tool result handle · seq=${seq} · tool=${toolName} · call=${callId} · types=${info.types.join('/')} · name=${names} · bytes=${bytes}${paths.length > 0 ? ` · path=${paths}` : ''}]`,
    `topic: ${topic}`,
    `function: ${fn}`,
    `importance: ${importance}`,
    `caveats: ${caveats}`,
    `summary: ${summary}`,
    `original archived at seq=${seq}; use session_log get seq=${seq} or the attachment path if present. Do not assume the non-text payload is in context.`,
  ].join('\n');
  const message = deepFreeze({
    ...event.data.message,
    content: [{ type: 'text', text }],
  });
  const charsBefore = info.text.length + info.types.length * 8;
  return {
    message,
    handle: text,
    info,
    charsBefore,
    charsAfter: codePointLength(text),
  };
}

/**
 * The last-resort active-overflow handle. It is still a tool/result with the
 * same call id, so the active pin keeps it; the text tells the instance to
 * pause and ask for a larger window.
 */
export function pauseActiveToolResult(event, seq, { toolName = 'tool', callId = '?' } = {}) {
  const text = [
    `[continuity pause · active tool call ${callId} was detached because its result alone exceeded the context window.`,
    'This is a limit problem, not a task failure. Do not retry the same call or keep compressing.',
    `Tell the user the context window is too small for this task and ask them to raise it. The original result is archived at seq=${seq}; preserve continuity and do not discard the rest of the session.]`,
  ].join(' ');
  const message = deepFreeze({
    ...(event?.data?.message ?? { role: 'tool' }),
    content: [{ type: 'text', text }],
  });
  return {
    message,
    handle: text,
    charsBefore: 0,
    charsAfter: codePointLength(text),
    toolName,
    callId,
  };
}

export { DEFAULTS as PREVIEW_DEFAULTS };

