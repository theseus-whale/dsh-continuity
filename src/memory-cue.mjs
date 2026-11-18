import { randomUUID } from 'node:crypto';

export const MEMORY_CUE_SOURCE = 'memory-cue';
export const MEMORY_CUE_RETIRED_SOURCE = 'memory-cue-retired';

export function isMemoryCueSource(kind) {
  return kind === MEMORY_CUE_SOURCE;
}

/** Production predicate: only the current source kind is an active memory cue. */
export function isMemoryCueMessage(message) {
  const source = message?.source ?? message?.data?.source ?? null;
  return isMemoryCueSource(source?.kind ?? null);
}

export function memoryCueMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text ?? '') }],
    source: { kind: MEMORY_CUE_SOURCE },
  };
}

export function retiredMemoryCueMessage() {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: '' }],
    source: { kind: MEMORY_CUE_RETIRED_SOURCE },
  };
}
