/**
 * Optional provider adapter. The core accepts any injectable async provider;
 * this helper is not wired to live sessions.
 */
export function deepseekSummaryProvider({ apiKey, model = 'deepseek-chat', fetchImpl = fetch }) {
  return async ({ turn, sourceView }) => {
    const response = await fetchImpl('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 800,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: `生成本轮 L 摘要，严格 JSON：{"turnId":"${turn.turnId}","L":"..."}；L 一句中文，<=256 字符。\n${sourceView}` }],
      }),
    });
    if (!response.ok) throw new Error(`provider HTTP ${response.status}`);
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    const parsed = JSON.parse(content);
    return { text: parsed?.L ?? null, provider: 'deepseek-api', model: payload?.model ?? null, usage: payload?.usage ?? null };
  };
}
