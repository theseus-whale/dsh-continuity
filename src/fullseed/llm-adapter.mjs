import { SUMMARY_PROMPT, PROMPT_TEXT_SHA256, EXTRACTION_RULE_SHA256, normalizeSummaryText } from './summary.mjs';

/**
 * Fullseed LLM transport. It sends the caller's prompt and raw chunk, then
 * returns the raw model text. Identity is assigned later from trusted chunk
 * metadata by summarizeChunk; writing/grounding warnings are not rejected here.
 */
export function createFullseedLlmProvider({ llm, provider, model, maxTokens = 800, reasoningEffort = 'off' }) {
  if (!llm || typeof llm.stream !== 'function') throw new Error('fullseed adapter: ctx.llm unavailable');
  if (!provider || !model) throw new Error('fullseed adapter: provider/model required');
  return async ({ prompt = SUMMARY_PROMPT, chunk, chunkId, sessionId = null, purpose = 'compaction' }) => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: `【待摘要历史原文开始】\n${chunk}\n【待摘要历史原文结束】` }] }];
    let text = '';
    let completedText = '';
    const chunkTypes = {};
    let usage = null;
    for await (const event of llm.stream({ provider, model, reasoningEffort, temperature: 0, maxTokens, system: prompt, messages,
      ...(sessionId ? { sessionId: String(sessionId) } : {}), ...(purpose ? { purpose } : {}) })) {
      const type = String(event?.type ?? 'unknown');
      chunkTypes[type] = (chunkTypes[type] ?? 0) + 1;
      if (event?.type === 'text-delta') text += event.text ?? '';
      else if (event?.type === 'block-end' && event?.block?.type === 'text') completedText += event.block.text ?? '';
      else if (event?.type === 'usage') usage = event.usage ?? null;
      else if (event?.type === 'finish' && event?.reason?.kind === 'error') {
        const failure = event.reason.failure;
        const message = failure?.message ?? 'model error';
        const code = failure?.code ?? failure?.failure?.code ?? null;
        const cause = failure instanceof Error ? failure : new Error(message, { cause: failure?.cause });
        throw new Error(`fullseed provider${code ? ` [${code}]` : ''}: ${message}`, { cause });
      }
    }
    const rawText = text || completedText;
    return { chunkId, text: normalizeSummaryText(rawText), rawText, provider, model, usage,
      streamStats: { chunkTypes, deltaChars: text.length, completedBlockChars: completedText.length },
      promptTextSha256: PROMPT_TEXT_SHA256, extractionRuleSha256: EXTRACTION_RULE_SHA256 };
  };
}
