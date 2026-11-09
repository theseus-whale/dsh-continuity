import os from 'node:os';
import path from 'node:path';
import { createPersistentCommandProvider } from '../src/memory/extraction-provider.mjs';

const cwd = process.cwd();
const python311 = path.join(cwd, '.venvs', 'extraction311', 'Scripts', 'python.exe');
const python38 = path.join(cwd, '.venvs', 'srl38', 'Scripts', 'python.exe');
const python313 = path.join(cwd, '.venvs', 'relik313', 'Scripts', 'python.exe');
const globalHf = process.env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface');
const workHf = path.join(cwd, '..', 'backups', 'continuity-tags-20261031', 'durable-memory', 'hf-cache');
const services = {
  ner: {
    provider: createPersistentCommandProvider({
      command: python311,
      args: [path.join(cwd, 'bin', 'extraction_service.py'), '--serve'],
      timeoutMs: 120000,
      env: { ...process.env, HF_HOME: globalHf, HF_HUB_OFFLINE: '1' },
    }),
    text: '彭小军认为，国内银行现在走的是台湾的发卡模式',
  },
  coref: {
    provider: createPersistentCommandProvider({
      command: python313,
      args: [path.join(cwd, 'bin', 'coref_service.py'), '--serve'],
      timeoutMs: 120000,
    }),
    text: 'Coo went to the lamp room. She looked at the coat.',
  },
  srl: {
    provider: createPersistentCommandProvider({
      command: python38,
      args: [path.join(cwd, 'bin', 'srl_service.py'), '--serve'],
      timeoutMs: 180000,
    }),
    text: 'The player kicked the ball into the net.',
  },
  el: {
    provider: createPersistentCommandProvider({
      command: python311,
      args: [path.join(cwd, 'bin', 'relik_service.py'), '--serve'],
      timeoutMs: 180000,
      env: { ...process.env, HF_HOME: workHf, HF_MODULES_CACHE: path.join(workHf, 'modules'), HF_HUB_OFFLINE: '1' },
    }),
    text: 'Michael Jordan played in the NBA.',
    candidates: ['Michael Jordan', 'National Basketball Association'],
  },
};

const result = {};
for (const [name, { provider, text, candidates }] of Object.entries(services)) {
  const latencies = [];
  for (let index = 0; index < 3; index += 1) {
    const response = await provider.extract(candidates ? { text, candidates } : { text });
    latencies.push({ ok: response.ok, latencyMs: response.latencyMs, reason: response.reason ?? null });
  }
  result[name] = { latencies, coldMs: latencies[0]?.latencyMs ?? null, warmMs: latencies.slice(1).map((item) => item.latencyMs) };
  provider.close();
}
console.log(JSON.stringify(result, null, 2));
