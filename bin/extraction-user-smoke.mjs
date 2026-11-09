import fs from 'node:fs';
import path from 'node:path';
import { createCommandProvider } from '../src/memory/extraction-provider.mjs';
import { PreTurnController } from '../src/memory/pre-turn.mjs';

const cwd = process.cwd();
const base = path.join(cwd, '..', 'backups', 'continuity-tags-20261031', 'durable-memory', 'build-a');
const provider = createCommandProvider({
  command: path.join(cwd, '.venvs', 'extraction311', 'Scripts', 'python.exe'),
  args: [path.join(cwd, 'bin', 'extraction_service.py')],
  timeoutMs: 60000,
});
const controller = new PreTurnController({ records: [] });
const lines = fs.readFileSync(path.join(cwd, '..', 'backups', 'continuity-tags-20261031', 'online400', 'user-only-messages.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).slice(0, 3);
const rows = [];
for (const line of lines) {
  const item = JSON.parse(line);
  const result = await controller.stepAsync({
    extractionProvider: provider,
    text: item.text,
    facets: { activity: '对话', topic: '记忆' },
    confidence: 0.8,
    nowTurn: 1,
  });
  rows.push({ text: item.text, extraction: result.extraction, gate: result.gate?.action, slots: result.slots });
}
fs.writeFileSync(path.join(base, 'USER-SERVICE-SMOKE.json'), JSON.stringify({ rows }, null, 2));
console.log(JSON.stringify({ n: rows.length, ok: rows.filter((row) => row.extraction?.ok).length }, null, 2));
