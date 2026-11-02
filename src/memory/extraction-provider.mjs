/**
 * Extraction provider: default off, cache-backed first.
 * Model-backed command mode is added in the next stage.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { attachStructuredExtraction } from './extraction-adapter.mjs';
import { validateEventSlots } from './event-model.mjs';
import { createCompositeProvider } from './extraction-composite.mjs';

export function resolveExtractionMode(env = process.env) {
  const raw = String(env.DSH_EXTRACTION_MODE ?? 'off').toLowerCase();
  if (raw === 'cache' || raw === 'model') return raw;
  return 'off';
}

export function splitArgs(value) {
  const text = String(value ?? '').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  const out = [];
  let current = '';
  let quote = null;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        out.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current) out.push(current);
  return out;
}

function keyFor(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

function readCache(cachePath) {
  if (!cachePath || !fs.existsSync(cachePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function createCacheProvider({ cachePath = null, mode = 'cache' } = {}) {
  const cache = mode === 'cache' ? readCache(cachePath) : {};
  return {
    mode,
    async extract({ text } = {}) {
      const started = Date.now();
      if (mode === 'off') return { ok: false, source: 'off', reason: 'disabled', latencyMs: 0 };
      const key = keyFor(text);
      const hit = cache[key];
      if (!hit) return { ok: false, source: 'cache', reason: 'cache-miss', latencyMs: Date.now() - started };
      if (hit.slots) {
        const checked = validateEventSlots(hit.slots);
        if (!checked.ok) return { ok: false, source: 'cache', reason: 'invalid-slots', errors: checked.errors, latencyMs: Date.now() - started };
        return { ok: true, source: 'cache', data: { ...hit, slots: checked.slots }, latencyMs: Date.now() - started };
      }
      return { ok: true, source: 'cache', data: hit, latencyMs: Date.now() - started };
    },
  };
}

function runCommand({ command, args = [], payload, timeoutMs = 8000, env = process.env }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, reason: 'timeout' });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish({ ok: false, reason: 'spawn-error', error: error.message }));
    child.on('close', (code) => {
      if (code !== 0) return finish({ ok: false, reason: 'exit-code', code, stderr: stderr.slice(-500) });
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      try {
        return finish({ ok: true, value: JSON.parse(lines.at(-1)) });
      } catch {
        return finish({ ok: false, reason: 'invalid-json', stderr: stderr.slice(-500) });
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export function createCommandProvider({ command, args = [], timeoutMs = 8000, env = process.env } = {}) {
  const invoke = async (payload) => {
    const started = Date.now();
    if (!command) return { ok: false, source: 'command', reason: 'missing-command', latencyMs: 0 };
    const run = await runCommand({ command, args, payload, timeoutMs, env });
    if (!run.ok) return { ok: false, source: 'command', ...run, latencyMs: Date.now() - started };
    const data = run.value ?? {};
    if (data.ok === false) return { ok: false, source: 'command', reason: data.reason ?? 'service-error', latencyMs: Date.now() - started };
    if (data.slots) {
      const checked = validateEventSlots(data.slots);
      if (!checked.ok) return { ok: false, source: 'command', reason: 'invalid-slots', errors: checked.errors, latencyMs: Date.now() - started };
      return { ok: true, source: 'command', data: { ...data, slots: checked.slots }, latencyMs: Date.now() - started };
    }
    return { ok: true, source: 'command', data, latencyMs: Date.now() - started };
  };
  return {
    mode: 'model',
    extract: ({ text, ...rest } = {}) => invoke({ text, ...rest }),
    healthCheck: () => invoke({ health: true }),
  };
}

export function createPersistentCommandProvider({ command, args = [], timeoutMs = 8000, env = process.env } = {}) {
  let child = null;
  let reader = null;
  let started = null;
  let seq = 0;
  const pending = new Map();

  const settle = (id, value) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(value);
  };

  const rejectAll = (reason) => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, reason });
      pending.delete(id);
    }
  };

  const start = () => {
    if (started) return started;
    started = new Promise((resolve, reject) => {
      if (!command) return reject(new Error('missing-command'));
      child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
      child.once('error', (error) => {
        reject(error);
        rejectAll('spawn-error');
      });
      child.once('close', () => {
        child = null;
        reader?.close();
        reader = null;
        started = null;
        rejectAll('process-exit');
      });
      reader = readline.createInterface({ input: child.stdout });
      reader.on('line', (line) => {
        try {
          const data = JSON.parse(line);
          if (data && data.id !== undefined) settle(data.id, { ok: true, data });
        } catch {
          /* ignore malformed lines; a timeout/crash will surface */
        }
      });
      child.stderr.on('data', () => {});
      resolve();
    });
    return started;
  };

  const request = async (payload) => {
    if (!command) return { ok: false, reason: 'missing-command' };
    try {
      await start();
    } catch (error) {
      return { ok: false, reason: 'spawn-error', error: error.message };
    }
    if (!child) return { ok: false, reason: 'not-running' };
    const id = ++seq;
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, reason: 'timeout' });
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    });
    return result;
  };

  return {
    mode: 'model',
    persistent: true,
    async extract({ text, ...rest } = {}) {
      const startedAt = Date.now();
      const response = await request({ text, ...rest });
      if (!response.ok) return { ok: false, source: 'persistent', reason: response.reason, latencyMs: Date.now() - startedAt };
      const data = response.data ?? {};
      if (data.ok === false) return { ok: false, source: 'persistent', reason: data.reason ?? 'service-error', latencyMs: Date.now() - startedAt };
      if (data.slots) {
        const checked = validateEventSlots(data.slots);
        if (!checked.ok) return { ok: false, source: 'persistent', reason: 'invalid-slots', errors: checked.errors, latencyMs: Date.now() - startedAt };
        return { ok: true, source: 'persistent', data: { ...data, slots: checked.slots }, latencyMs: Date.now() - startedAt };
      }
      return { ok: true, source: 'persistent', data, latencyMs: Date.now() - startedAt };
    },
    healthCheck: () => request({ health: true }),
    close() {
      if (child) child.kill();
      child = null;
      reader?.close();
      reader = null;
      started = null;
      rejectAll('closed');
    },
  };
}

export function createExtractionProviderFromEnv(env = process.env) {
  const mode = resolveExtractionMode(env);
  if (mode === 'off') return createCacheProvider({ mode: 'off' });
  if (mode === 'cache') return createCacheProvider({ cachePath: env.DSH_EXTRACTION_CACHE ?? null, mode: 'cache' });
  if (env.DSH_EXTRACTION_CONFIG) {
    const configPath = path.resolve(env.DSH_EXTRACTION_CONFIG);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const persistent = config.persistent !== false && env.DSH_EXTRACTION_PERSISTENT !== '0';
    const factory = persistent ? createPersistentCommandProvider : createCommandProvider;
    const service = (spec = {}) => factory({
      command: spec.command ?? null,
      args: Array.isArray(spec.args) ? spec.args.map(String) : [],
      timeoutMs: Number(spec.timeoutMs ?? env.DSH_EXTRACTION_TIMEOUT_MS ?? 8000),
      env: { ...env, ...(spec.env ?? {}) },
    });
    const ner = service(config.services?.ner);
    return createCompositeProvider({
      ner,
      coref: config.services?.coref ? service(config.services.coref) : null,
      srl: config.services?.srl ? service(config.services.srl) : null,
      el: config.services?.el ? service(config.services.el) : null,
    });
  }
  const factory = env.DSH_EXTRACTION_PERSISTENT === '1' ? createPersistentCommandProvider : createCommandProvider;
  return factory({
    command: env.DSH_EXTRACTION_COMMAND ?? null,
    args: splitArgs(env.DSH_EXTRACTION_ARGS),
    timeoutMs: Number(env.DSH_EXTRACTION_TIMEOUT_MS ?? 8000),
    env,
  });
}

export async function stepWithProvider(controller, provider, {
  text,
  role = 'user',
  facets = {},
  confidence = 1,
  nowTurn = 0,
} = {}) {
  const extraction = await provider.extract({ text });
  if (!extraction.ok) {
    const gate = controller.step({ text, role, facets, confidence, eventSlots: null, nowTurn });
    return { ok: false, extraction, gate };
  }
  const data = extraction.data ?? {};
  const result = attachStructuredExtraction(controller, {
    text,
    role,
    facets,
    confidence,
    nowTurn,
    slots: data.slots ?? null,
    srl: data.srl ?? null,
    corefClusters: data.corefClusters ?? [],
    entityLinks: data.entityLinks ?? [],
  });
  return { ok: result.ok, extraction, ...result };
}
