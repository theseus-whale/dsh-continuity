import fs from 'node:fs';
import { createExtractionProviderFromEnv } from '../src/memory/extraction-provider.mjs';
import { createExtractionPreStep } from '../src/memory/extraction-pre-step.mjs';

const config = 'C:/Users/35794/Documents/DeepSeek\'s Sandbox/coopanion-continuity/backups/continuity-tags-20261031/durable-memory/extraction-live.json';
const provider = createExtractionProviderFromEnv({ DSH_EXTRACTION_MODE: 'model', DSH_EXTRACTION_CONFIG: config });
const handler = createExtractionPreStep({ provider, mode: 'model' });
const text = 'Coo在灯室拿起钥匙，准备去找宁。';
const decision = { kind: 'accept', messages: [{ role: 'user', content: [{ type: 'text', text }] }] };
const result = await handler({ step: 1 }, async () => decision);
fs.writeFileSync('C:/Users/35794/Documents/DeepSeek\'s Sandbox/coopanion-continuity/backups/continuity-tags-20261031/durable-memory/build-a/LIVE-PREVIEW.json', JSON.stringify({ text, messages: result.messages, extraction: result.extraction }, null, 2));
provider.close?.();
console.log(JSON.stringify({ messages: result.messages.length, ok: result.extraction?.ok, slots: result.extraction?.data?.slots }, null, 2));
