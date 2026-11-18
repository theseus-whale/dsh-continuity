import { SUMMARY_PROMPT, PROMPT_TEXT_SHA256, EXTRACTION_RULE_SHA256, normalizeSummaryText } from './summary.mjs';

/**
 * Fullseed LLM transport. It sends the caller's prompt and raw chunk, then
 * returns the raw model text. Identity is assigned later from trusted chunk
 * metadata by summarizeChunk; writing/grounding warnings are not rejected here.
 */
export function createFullseedLlmProvider({ llm, provider, model, maxTokens = 800 }) {
  if (!llm || typeof llm.stream !== 'function') throw new Error('fullseed adapter: ctx.llm unavailable');
  if (!provider || !model) throw new Error('fullseed adapter: provider/model required');
  return async ({ prompt = SUMMARY_PROMPT, chunk, chunkId }) => {
    const messages = [{ role: 'user', content: `${prompt}\n\n${chunk}` }];
    let text = '';
    let usage = null;
    for await (const event of llm.stream({ provider, model, temperature: 0, maxTokens, messages })) {
      if (event?.type === 'text-delta') text += event.text ?? '';
      else if (event?.type === 'usage') usage = event.usage ?? null;
      else if (event?.type === 'finish' && event?.reason?.kind === 'error') throw new Error(`fullseed provider: ${event.reason.failure?.message ?? 'model error'}`);
    }
    return { chunkId, text: normalizeSummaryText(text), rawText: text, provider, model, usage, promptTextSha256: PROMPT_TEXT_SHA256, extractionRuleSha256: EXTRACTION_RULE_SHA256 };
  };
}
