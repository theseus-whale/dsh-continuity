/**
 * Pre-step hook prototype for extraction.
 * Not registered by index.mjs yet; registration is a separate, explicit switch.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { userMessage } from '../threads.mjs';
import { createExtractionProviderFromEnv } from './extraction-provider.mjs';
import { attachStructuredExtraction } from './extraction-adapter.mjs';
import { buildRecallIndex, findRecall, renderRecall } from './recall.mjs';

const MACHINE_PREFIX = /^(?:Current runtime context|Current working directory|Current DSH file policy|Approval prompts|Time sampled|\[(?:抽取|工作线|标签|规则|习惯|技能|归位|候选|存\?|闸|回正|学习|追忆|记忆|continuity:[a-z-]+)\])/;

function isHumanMessage(message, text) {
  const source = message?.source ?? message?.data?.source;
  if (source && typeof source.kind === 'string' && source.kind !== 'user') return false;
  if (source && source.peer === true) return false;
  if (MACHINE_PREFIX.test(text.trimStart())) return false;
  return true;
}

function textOf(message) {
  if (!message || message.role !== 'user') return '';
  const content = message.content;
  if (typeof content === 'string') return isHumanMessage(message, content) ? content : '';
  if (!Array.isArray(content)) return '';
  const text = content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
  return isHumanMessage(message, text) ? text : '';
}

export function lastUserText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = textOf(messages[index]);
    if (text) return text;
  }
  return '';
}

export function createExtractionPreStep({ provider = null, mode = 'off', prefix = '[抽取]', controller = null, recall = null } = {}) {
  return async function extractionPreStep(payload, next) {
    const decision = await next();
    if (mode === 'off' || !provider || !decision || !Array.isArray(decision.messages)) return decision;
    if (Number.isInteger(payload?.step) && payload.step !== 1) return decision;
    const text = lastUserText(decision.messages);
    if (!text) return decision;
    let recallLine = null;
    if (typeof recall === 'function') {
      try {
        recallLine = await recall({ text, agent: payload?.agent ?? null });
      } catch {
        recallLine = null;
      }
    }
    const extraction = await provider.extract({ text });
    if (!extraction?.ok) {
      if (!recallLine) return { ...decision, extraction };
      return {
        ...decision,
        messages: [...decision.messages, userMessage(recallLine)],
        extraction,
        recall: recallLine,
      };
    }
    const data = extraction.data ?? {};
    let attached = null;
    if (controller) {
      attached = attachStructuredExtraction(controller, {
        text,
        slots: data.slots ?? {},
        srl: data.srl ?? null,
        corefClusters: data.corefClusters ?? [],
        entityLinks: data.entityLinks ?? [],
      });
      if (!attached.ok) return { ...decision, extraction, attached };
    }
    const slots = attached?.slots ?? data.slots ?? {};
    const hasSignal = (slots.characters?.length ?? 0) > 0
      || Boolean(slots.location)
      || (slots.objects?.length ?? 0) > 0
      || Boolean(slots.goal)
      || Boolean(data.srl?.verb)
      || (data.entityLinks?.length ?? 0) > 0;
    if (!hasSignal) {
      if (!recallLine) return { ...decision, extraction, gate: attached?.gate ?? null };
      return {
        ...decision,
        messages: [...decision.messages, userMessage(recallLine)],
        extraction,
        recall: recallLine,
        gate: attached?.gate ?? null,
      };
    }
    const lines = [
      `${prefix} ${data.lang ?? ''}`.trim(),
      `characters: ${(slots.characters ?? []).join(', ') || '-'}`,
      `location: ${slots.location ?? '-'}`,
      `objects: ${(slots.objects ?? []).join(', ') || '-'}`,
      `goal: ${slots.goal ?? '-'}`,
    ];
    if (data.srl?.verb) lines.push(`srl: ${data.srl.verb} (${data.srl.frame ?? '-'})`);
    if (data.entityLinks?.length) lines.push(`links: ${data.entityLinks.map((link) => `${link.text}=${link.referent ?? link.entityId ?? link.id ?? 'NIL'}`).join(', ')}`);
    if (recallLine) lines.push(recallLine);
    return {
      ...decision,
      messages: [...decision.messages, userMessage(lines.join('\n'))],
      extraction,
      recall: recallLine,
      gate: attached?.gate ?? null,
    };
  };
}

export function registerExtractionPreStep(ctx, options = {}) {
  if (options.mode === 'off' || !options.provider) return false;
  if (!ctx || typeof ctx.on !== 'function') return false;
  ctx.on('agent/pre-step', createExtractionPreStep(options));
  return true;
}

export function installExtractionPreStep(ctx, env = process.env, { sessionQuery = null } = {}) {
  const mode = String(env.DSH_EXTRACTION_MODE ?? 'off').toLowerCase();
  if (mode !== 'cache' && mode !== 'model') return { mode, registered: false, provider: null };
  try {
    const provider = createExtractionProviderFromEnv(env);
    const recall = sessionQuery && typeof sessionQuery.readSession === 'function'
      ? async ({ text, agent }) => {
        const sessionId = agent?.session?.id;
        if (sessionId === undefined || sessionId === null) return null;
        const snapshot = await sessionQuery.readSession(sessionId);
        const built = buildRecallIndex(snapshot?.events ?? [], {
          beforeTurn: Number.isInteger(agent?.lastTurn) ? agent.lastTurn : Infinity,
        });
        const hits = findRecall(built, text, { topK: 1, minCoverage: 0.25 });
        return hits.length > 0 ? renderRecall(hits[0], text) : null;
      }
      : null;
    const registered = registerExtractionPreStep(ctx, { provider, mode, recall });
    return { mode, registered, provider };
  } catch (error) {
    return { mode, registered: false, provider: null, error: error?.message ?? String(error) };
  }
}

export function recordExtractionInstallError(error, { home = process.env.USERPROFILE ?? process.env.HOME ?? '', log = console } = {}) {
  const message = String(error?.message ?? error);
  try {
    const file = join(home, '.dsh', 'continuity', 'gate-errors.jsonl');
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({
      at: new Date().toISOString(),
      name: error?.name ?? 'Error',
      code: 'extraction-pre-step-register',
      message,
    }) + '\n', 'utf8');
  } catch { /* best effort, same as the install catch */ }
  log?.warn?.(`[dsh-continuity] extraction pre-step failed: ${message}`);
}
