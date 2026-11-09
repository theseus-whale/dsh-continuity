import fs from 'node:fs';
import { createExtractionProviderFromEnv } from '../src/memory/extraction-provider.mjs';
import { createExtractionPreStep } from '../src/memory/extraction-pre-step.mjs';

const config = 'C:/Users/35794/Documents/DeepSeek\'s Sandbox/coopanion-continuity/backups/continuity-tags-20261031/durable-memory/extraction-live.json';
const text = '我要的是全自动化。这是你之前自己说的：这一套可以让LLM什么都不额外做，就正常聊天，然后自动系统在用户说到“我们接下来去 *** 吧” （比如跑团），时，就会自动给LLM补充一个“【可回忆】灯塔 / 钥匙 ---> turn49”这类的提示词。这个提示词就是自动算出facet，自动算出高置信度区间，回填turn49，然后LLM读到这个直接去load 49那里对应的seq就能找回原始上下文，然后它就直接想起来了。';
const provider = createExtractionProviderFromEnv({ DSH_EXTRACTION_MODE: 'model', DSH_EXTRACTION_CONFIG: config });
const result = await provider.extract({ text });
const handler = createExtractionPreStep({ provider, mode: 'model' });
const decision = { kind: 'accept', messages: [{ role: 'user', content: [{ type: 'text', text }] }] };
const injected = await handler({ step: 1 }, async () => decision);
fs.writeFileSync('C:/Users/35794/Documents/DeepSeek\'s Sandbox/coopanion-continuity/backups/continuity-tags-20261031/durable-memory/build-a/EXTRACT-PARAGRAPH.json', JSON.stringify({ result, injected }, null, 2));
console.log(JSON.stringify({ ok: result.ok, latencyMs: result.latencyMs, data: result.data, injected: injected.messages.at(-1)?.content?.[0]?.text }, null, 2));
provider.close?.();
