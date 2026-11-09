import path from 'node:path';
import { createCommandProvider } from '../src/memory/extraction-provider.mjs';
import { createCompositeProvider } from '../src/memory/extraction-composite.mjs';
import { PreTurnController } from '../src/memory/pre-turn.mjs';

const cwd = process.cwd();
const python311 = path.join(cwd, '.venvs', 'extraction311', 'Scripts', 'python.exe');
const python38 = path.join(cwd, '.venvs', 'srl38', 'Scripts', 'python.exe');
const python313 = path.join(cwd, '.venvs', 'relik313', 'Scripts', 'python.exe');
const globalHf = 'C:\\Users\\35794\\.cache\\huggingface';
const workHf = path.join(cwd, '..', 'backups', 'continuity-tags-20261031', 'durable-memory', 'hf-cache');
const nerEnv = { ...process.env, HF_HOME: globalHf, HF_HUB_OFFLINE: '1' };
const elEnv = { ...process.env, HF_HOME: workHf, HF_MODULES_CACHE: path.join(workHf, 'modules'), HF_HUB_OFFLINE: '1' };
const provider = createCompositeProvider({
  ner: createCommandProvider({ command: python311, args: [path.join(cwd, 'bin', 'extraction_service.py')], timeoutMs: 120000, env: nerEnv }),
  coref: createCommandProvider({ command: python313, args: [path.join(cwd, 'bin', 'coref_service.py')], timeoutMs: 120000 }),
  srl: createCommandProvider({ command: python38, args: [path.join(cwd, 'bin', 'srl_service.py')], timeoutMs: 180000 }),
  el: createCommandProvider({ command: python311, args: [path.join(cwd, 'bin', 'relik_service.py')], timeoutMs: 180000, env: elEnv }),
});
const controller = new PreTurnController({ records: [] });
const result = await controller.stepAsync({
  extractionProvider: provider,
  text: 'Michael Jordan kicked the ball into the net.',
  facets: { activity: '对话', topic: '体育' },
  confidence: 0.8,
  nowTurn: 1,
});
console.log(JSON.stringify({ ok: result.ok, slots: result.slots, predicate: result.predicate, links: result.entityLinks, partial: result.extraction?.data?.partial }, null, 2));
