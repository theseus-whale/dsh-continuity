const PSEUDO_TOOL = /<\s*readSeqRange\b/i;

export async function runAnswer({
  messages,
  provider,
  tools = null,
  readSeqRange = null,
  config,
}) {
  const rawReads = [];
  const usage = [];
  let providerCalls = 0;
  let boundedToolLimit = false;
  let finalNoToolAnswer = false;
  let malformedToolOutput = false;
  let answer = null;
  let error = null;
  let actualModel = null;
  const working = messages.map((message) => ({ ...message }));

  const call = async (toolsEnabled, note = null) => {
    providerCalls += 1;
    const input = note
      ? [...working, { role: 'system', content: note }]
      : working;
    const response = await provider({ messages: input, tools: toolsEnabled ? tools : null });
    actualModel = response?.model ?? actualModel;
    if (response?.usage) usage.push(response.usage);
    return response;
  };

  try {
    for (let callIndex = 1; callIndex <= config.raw.maxProviderCalls; callIndex += 1) {
      const response = await call(true);
      const toolCalls = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
      if (toolCalls.length === 0) {
        answer = response?.content ?? null;
        if (typeof answer !== 'string') throw new Error('missing final content');
        break;
      }
      if (rawReads.length >= config.raw.maxReadsPerAnswer || callIndex >= config.raw.maxProviderCalls) {
        boundedToolLimit = true;
        if (!config.raw.finalNoToolAnswer || callIndex >= config.raw.maxProviderCalls) {
          error = 'bounded-tool-limit';
          break;
        }
        const final = await call(false, 'No more tools are available. Answer the user now using the query, memory resonance, and any text already read; state clearly if evidence is insufficient.');
        finalNoToolAnswer = true;
        if (Array.isArray(final?.toolCalls) && final.toolCalls.length > 0) {
          error = 'final-answer-requested-tool';
          break;
        }
        answer = final?.content ?? null;
        if (typeof answer !== 'string') throw new Error('missing final no-tool content');
        break;
      }
      if (!readSeqRange) throw new Error('readSeqRange unavailable');
      if (rawReads.length + toolCalls.length > config.raw.maxReadsPerAnswer) {
        boundedToolLimit = true;
        if (!config.raw.finalNoToolAnswer) { error = 'bounded-tool-limit'; break; }
        const final = await call(false, 'No more tools are available. Answer the user now using the query, memory resonance, and any text already read; state clearly if evidence is insufficient.');
        finalNoToolAnswer = true;
        answer = final?.content ?? null;
        if (typeof answer !== 'string') throw new Error('missing final no-tool content');
        break;
      }
      working.push({ role: 'assistant', content: response?.content ?? '', tool_calls: toolCalls });
      for (const toolCall of toolCalls) {
        if (toolCall?.name !== 'readSeqRange') { error = `unsupported-tool:${toolCall?.name ?? 'unknown'}`; break; }
        let args;
        try { args = typeof toolCall.arguments === 'string' ? JSON.parse(toolCall.arguments) : toolCall.arguments; } catch { error = 'invalid-tool-json'; break; }
        const result = await readSeqRange(args?.fromSeq, args?.toSeq);
        rawReads.push({ fromSeq: args?.fromSeq, toSeq: args?.toSeq, bytes: result?.bytes ?? 0, truncated: Boolean(result?.truncated), error: result?.error ?? null });
        working.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) });
      }
      if (error) break;
    }
  } catch (caught) {
    error = String(caught?.message ?? caught);
  }
  if (typeof answer === 'string' && PSEUDO_TOOL.test(answer)) malformedToolOutput = true;
  return {
    answer,
    providerCalls,
    rawReads,
    usage,
    actualModel,
    boundedToolLimit,
    finalNoToolAnswer,
    malformedToolOutput,
    error: error ?? (answer === null ? 'no-final-answer' : null),
  };
}
