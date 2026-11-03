/**
 * dsh-continuity — band-controlled compaction engine.
 *
 * Extends the shipped `BasicCompactionEngine` so the durable replacement
 * transaction, balancing rules, overwrite detection, and manual `/compact`
 * path stay inherited. This subclass changes only three things:
 *
 *   1. `compactIfNeeded` — a band controller chooses a *small* oldest range
 *      (`measure` + `planFold` + `oldestRange`) instead of the base
 *      threshold-and-cliff cut; overflow still delegates to the base.
 *   2. `oldestRange` — walk the session surface from the oldest non-system
 *      node, stop at the pass budget or the protected tail, and move the end
 *      back to a tool-pairing-balanced cut.
 *   3. `summarize` — prepend the provenance header for the selected range, so
 *      the replacement checkpoint says which stretch it is a gist of.
 *
 * The base class is resolved from the Host's own package installation when
 * possible (Electron `app.asar`), because `Service` registration and the
 * compaction service must come from the same Cordis generation. A plain
 * `@deepseek-ai/*` import is the portable fallback.
 *
 * The module deliberately has no static DSH imports: a failed base import is
 * reported by the panel instead of preventing the Host row from loading.
 */
import { join } from 'node:path';
import { appendFileSync, existsSync, readFileSync, unlinkSync as fsUnlink, writeFileSync } from 'node:fs';
import { readSkillsIndex, skillsForThreads, skillsForKeywords, buildSkillsBlock } from './skills.mjs';
import { note, topCandidates, scanResults } from './learning.mjs';
import { detectGroups, nameFromEvidence } from './groups.mjs';
import { extractMood, parseMoodLog, selectMood, shouldRecord } from './mood.mjs';
import { trainingMode, autoLearn } from './training.mjs';
import { needsFullInjection, needsSkillInjection } from './inject-policy.mjs';
import { maybeBackupSession } from './backup.mjs';
import { selectTopic } from './topic.mjs';
import {
  bumpTagCount,
  resetTagCount,
  parseRecheckAnswer,
  recheckAutoText,
  recheckRetryText,
} from './recheck.mjs';
import { attributeTurnSeqs, deriveTurnTag } from './turn-tag.mjs';
import { findTagDeclaration } from './tag-detect.mjs';
import { findNearLabel, hasWordEvidence, splitNewToken, tagTokenFromDeclaration } from './tag-confirm.mjs';
import { consumeTagReject, recordTagReject } from './tag-reject.mjs';
import { latestUserTurnFromSession, messageSourceKind } from './user-turn.mjs';
import { loadAnswered, filterAnswered } from './learning.mjs';

import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { eventText } from './session-log.mjs';
import { planFold, resolvePolicy } from './policy.mjs';
import { annotateSummary, gistHeader, SYSTEM_CONVENTION } from './provenance.mjs';
import { selectOldestRange } from './range.mjs';
import { planFacetFold, loadFacetFoldFile, defaultFacetFoldFile } from './facets/fold-plan.mjs';
import {
  activeLine,
  activePinSeqsFromState,
  contextMessage,
  dominanceStartSeq,
  isoOf,
  latestTurnStartSeq,
  minutesBetween,
  normalizeThread,
  RESIDUE_MAX_CHARS,
  selectSaveRange,
  summarizeRules,
  tagStatusLine,
  threadContextText,
  threadGistText,
  gateMessage,
} from './threads.mjs';
import { setThreadsBackend } from './threads-backend.mjs';
import { getSession, readRules, readHabits, updateSession } from './threads-store.mjs';
import { readTags, updateTags, writeTagsMd } from './tags-store.mjs';
import { runMaintenance } from './tag-maintenance.mjs';
import {
  migrateAliasTags,
  renderTagsMd,
  resolveTag,
  tagCoverageForRange,
  tagsView,
  TAG_ZERO,
  matchableTags,
  canonicalTagId,
} from './tags.mjs';
import { recordFold } from './folds-store.mjs';
import {
  activeCallIds,
  activePinSeqs,
  compressionBudget,
  handleNonTextToolResult,
  nonTextInfo,
  oldestPinIndex,
  pauseActiveToolResult,
  previewSummaryInput,
  previewToolResultEvent,
  targetFractionFor,
  toolCallMap,
} from './tool-preview.mjs';
import {
  continuityState,
  markEngine,
  markEngineSession,
  markThreadsSnapshot,
  recordContext,
  recordError,
  recordPass,
  recordPreview,
} from './state.mjs';

/** Normalize a base result's shadowed span; the inherited engine can return reversed ends. */
function shadowedSpan(result) {
  const raw = result?.shadowedRange;
  const a = Number(raw?.start);
  const b = Number(raw?.end);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

/** One line the model can read after a cut, derived from the same pass record. */
function passReceiptLine(pass) {
  const n = (value) => Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '?';
  const range = pass.start === undefined || pass.end === undefined
    ? 'seq ?'
    : `seq ${pass.start}\u2013${pass.end}`;
  const window = Number.isFinite(pass.windowTokens) ? ` \u00b7 window ${n(pass.windowTokens)}` : '';
  const policy = pass.protectBinds === true
    ? ` \u00b7 protectBinds \u00b7 baseline ${n(pass.afterBaselineTokens)} \u00b7 floor ${n(pass.floorTokens)} \u2265 low ${n(pass.lowTargetTokens)} \u00b7 suggest protect \u2264 ${Number.isFinite(pass.protectSuggested) ? pass.protectSuggested.toFixed(3) : '?'}`
    : '';
  return `[continuity:fold] ${range} \u00b7 ${pass.count ?? '?'} \u6761 \u00b7 ${n(pass.tokens)} tokens \u00b7 reason=${pass.reason ?? '?'} \u00b7 \u538b\u524d ${n(pass.estTokens)} \u2192 \u538b\u540e ${n(pass.afterTokens)}${window}${policy}`;
}

/** Append the receipt as a user-role line; never let diagnostics block the pass. */
function appendPassReceipt(agent, pass) {
  try {
    agent?.session?.append?.('user/message', contextMessage(passReceiptLine(pass)), { surfaceOp: 'append' });
  } catch (error) {
    try { recordError(error?.message ?? String(error), 'pass-receipt'); } catch { /* ignore */ }
  }
}


/** One standing convention, mounted once in the preset's system-prompt layer. */
const SECTION_NAME = 'continuity:provenance';

/** After the tool sections (5000–9000) and before structured output (9900). */
const SECTION_ORDER = 9500;

/**
 * Import a DSH package, preferring the running Host's own copy.
 *
 * `process.resourcesPath` exists in the Electron desktop shell, whose dsh
 * runtime lives under `resources/app.asar/dsh`. The bare specifier fallback
 * serves CLI profiles and tests.
 */
async function importHostPackage(name) {
  const candidates = [];
  const resources = process.resourcesPath;
  if (typeof resources === 'string' && resources.length > 0) {
    candidates.push(pathToFileURL(join(
      resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', name, 'lib', 'index.js',
    )).href);
    candidates.push(pathToFileURL(join(
      resources, 'app.asar', 'node_modules', '@deepseek-ai', name, 'lib', 'index.js',
    )).href);
  }
  candidates.push(`@deepseek-ai/${name}`);

  const failures = [];
  for (const candidate of candidates) {
    try {
      return { module: await import(candidate), source: candidate };
    } catch (error) {
      failures.push(`${candidate} (${error?.message ?? error})`);
    }
  }
  throw new Error(`dsh-continuity: cannot load @deepseek-ai/${name}; tried: ${failures.join(' | ')}`);
}

const basicImport = await importHostPackage('dsh-compaction-basic');
const compactionImport = await importHostPackage('dsh-compaction');

const BaseEngine = basicImport.module.BasicCompactionEngine ?? basicImport.module.default;
const toolPairingBalancedBefore = compactionImport.module.toolPairingBalancedBefore;
const toolPairingBalancedAfter = compactionImport.module.toolPairingBalancedAfter;

if (typeof BaseEngine !== 'function') {
  throw new Error('dsh-continuity: @deepseek-ai/dsh-compaction-basic exported no BasicCompactionEngine');
}
if (typeof toolPairingBalancedBefore !== 'function' || typeof toolPairingBalancedAfter !== 'function') {
  throw new Error('dsh-continuity: @deepseek-ai/dsh-compaction exported no tool-pairing predicates');
}

/** @typedef {{ session: object, options?: { provider?: string, model?: string } }} AgentContext */

export class ContinuityEngine extends BaseEngine {
  static inject = Array.isArray(BaseEngine.inject)
    ? [...BaseEngine.inject]
    : ['llm', 'tokenMeter', 'sessions'];

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {{ policy?: object, provenance?: object, compactionBasic?: object }} [config]
   */
  constructor(ctx, config = {}) {
    super(ctx, config.compactionBasic ?? {});
    this.continuity = resolvePolicy(config.policy ?? {});
    this.facetNative = config.facetNative === true;
    this.facetFold = config.facetFold ?? null;
    if (this.facetFold === null) {
      const file = defaultFacetFoldFile();
      try {
        if (existsSync(file)) this.facetFold = loadFacetFoldFile(file);
      } catch {
        this.facetFold = null;
      }
    }
    const provenance = config.provenance ?? {};
    this.provenance = {
      header: provenance.header !== false,
      standingConvention: provenance.standingConvention !== false,
    };
    const threadConfig = config.threads ?? {};
    this.threads = {
      inject: threadConfig.inject !== false,
      pin: threadConfig.pin !== false,
      pointersOnly: threadConfig.pointersOnly === true,
    };
    this.turnGateEnabled = config.turnGate?.enabled !== false;
    /** 回合闸：每轮最多催几次补标（防无限循环）。 */
    this.turnSteerCount = new Map();
    /** 回合闸：每轮答错几次（用来在消息里写「你已经回答错误 N 次」）。 */
    this.turnTagErrors = new Map();
    /** 第一次打标教学：每个会话只出现一次。 */
    this.tagLearnShown = new Set();
    /** 回查闸：turn → { threadId, alias, invalid }，只在一轮内有效。 */
    this.recheckPending = new Map();
    /** 回合闸的安全阀状态：{ startedAt, lastHash, repeats }，防同一轮无限循环。 */
    this.turnGate = new Map();
    /** 回合闸去重：turn → 上次处理时间（engine 与 index 两边都会注册，防重复执行）。 */
    this.turnGateLastRun = new Map();
    // 回合闸（2026-10-30）：宿主在轮次即将关闭时派发 'agent/turn-stopping'，
    // 监听者可以 steer 让本轮保持打开。这就是“没打标不许收尾”的落点——
    // 不是去锁 save（那只会让实例最后存不下东西、消失），而是不让这一轮就这么结束。
    try {
      if (typeof this.ctx?.on !== 'function') {
        // 引擎的 ctx 接不到 agent 事件是已知情况；真正注册在 index.mjs 的 apply() 里。
        // 这里只留个痕，方便对照“到底哪条路在生效”。
        appendFileSync(join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity', 'hook-notes.jsonl'),
          JSON.stringify({ at: new Date().toISOString(), note: 'engine ctx 没有 on()，跳过自身注册（改由 index.apply 注册）' }) + '\n', 'utf8');
      } else {
        this.ctx.on('agent/turn-stopping', (payload) => {
          void this.onTurnStopping(payload);
        });
        // Compaction rebuilds the surface; a just-issued steer can be swallowed.
        // Clear the one-time teaching marker so the next error teaches again.
        this.ctx.on('compaction/start', () => { this.tagLearnShown.clear(); });
      }
    } catch (error) {
      try {
        appendFileSync(join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity', 'gate-errors.jsonl'),
          JSON.stringify({ at: new Date().toISOString(), name: error?.name ?? 'Error', code: 'turn-stopping-register', message: String(error?.message ?? error) }) + '\n', 'utf8');
      } catch { /* 注册失败只影响这道闸 */ }
    }
    /** Header for the next summarize() call, keyed by agent (concurrent sessions are independent). */
    this.headers = new WeakMap();
    /** Last measurement per agent, reused by oldestRange(). */
    this.measured = new WeakMap();
    /** Resolved model metadata, cached per provider/model. */
    this.modelInfo = new Map();
    this.warned = new Set();
    /** One-shot thread gist text for the next summarize(), keyed by agent. */
    this.threadGist = new WeakMap();
    /** Last turn whose active/rules line was injected, keyed by agent. */
    this.threadInjectTurn = new WeakMap();
    /** Last skill set injected into a turn, keyed by agent. */
    this.skillInjectKey = new WeakMap();
    /** seq of the message that carried the skill body, so we can tell if it survived compaction. */
    this.skillMsgSeq = new WeakMap();
    /** seq of the message that carried the full rules text. */
    this.rulesMsgSeq = new WeakMap();
    /** Hash of the rules text last injected, so edits force a fresh full copy. */
    this.rulesSignature = new WeakMap();
    /** habits.md shares the same carrier as rules; separate hashes for change detection. */
    this.habitsMsgSeq = new WeakMap();
    this.habitsSignature = new WeakMap();
    /** Last header signature + seq, so unchanged turns reuse the message already in surface. */
    this.headerState = new WeakMap();
    /** Same segment's [存?] prompt is emitted once. */
    this.saveAsked = new WeakMap();
    /** Rules-size warning is emitted once per size signature. */
    this.rulesSizeShown = new WeakMap();
    /** 学习候选：工具回执里的重复错误签名 → {count, firstSeq, lastSeq}。 */
    this.learning = new Map();
    this.learningCursor = 0;
    this.learningShown = new Set();
    this.learningInit = false;
    /** 分叉闸：工具回执指纹 / 连续无新信息轮数 / 上次提醒值。 */
    this.infoHashes = new Set();
    this.infoCursor = 0;
    this.infoInit = false;
    this.stallTurns = 0;
    this.stallShownAt = 0;
    /** 回查状态持久化在 recheck-state.json，不再放在实例 Map 里。 */
    /** 存提醒：{ [threadId]: { toSeq, turns } } */
    this.segIdle = new Map();
    /** mood：扫描游标与初始化标记。 */
    this.moodCursor = 0;
    this.moodInit = false;
    /** 回正测试：{ [threadId]: { turns, asked } } */
    this.rebuildTurns = new Map();
    /** 归拢提议：已问过的键，避免重复提问。 */
    this.groupShown = new Set();
    /** Bridge the preset-root thread tool to this isolated compaction service. */
    setThreadsBackend({
      prepareSave: (agent, args) => this.prepareSave(agent, args),
      saveThread: (agent, args, signal) => this.saveThread(agent, args, signal),
    });

    if (this.provenance.standingConvention) this.mountConvention();

    const resolved = this.config ?? {};
    markEngine({
      instance: this,
      policy: this.continuity,
      provenance: this.provenance,
      compactionBasic: {
        thresholdRatio: resolved.thresholdRatio,
        retainRatio: resolved.retainRatio,
        retainTokens: resolved.retainTokens,
        headroomTokens: resolved.headroomTokens,
        maxTokens: resolved.maxTokens,
        auto: resolved.auto,
      },
      base: {
        package: basicImport.source,
        pairing: compactionImport.source,
        standingConvention: this.provenance.standingConvention ? 'pending' : 'disabled',
      },
    });

    // 0.8.57: deterministic tag hygiene. Startup is best-effort; save is strict.
    void runMaintenance({ mode: 'startup' }).catch((error) => {
      try { this.logger?.warn?.(`[dsh-continuity] tag maintenance failed: ${error?.message ?? error}`); } catch { /* ignore */ }
    });
  }

  /** Register SYSTEM_CONVENTION once, in this engine's (preset) scope. */
  mountConvention() {
    const register = (scoped) => {
      scoped.systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        text: SYSTEM_CONVENTION,
        interpolate: false,
      });
      const engine = continuityState.engine;
      if (engine !== null) engine.base.standingConvention = 'registered';
    };
    if (typeof this.ctx.inject === 'function') {
      this.ctx.inject(['systemPrompt'], register);
      return;
    }
    if (this.ctx.get('systemPrompt') !== undefined) register(this.ctx);
  }

  /**
   * Read the used and usable token budget for the agent's latest routed
   * request: `ctx.tokenMeter.measure(session)` for pressure and
   * `ctx.llm.resolveModelInfo(...).context.contextWindow` minus the request's
   * reserved completion tokens for capacity.
   *
   * @param {AgentContext} agent
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ estTokens: number, windowTokens: number, contextWindow: number|null, reservedTokens: number, surfaceTokens: number, provider: string, model: string, measurement: object }>}
   */
  async measure(agent, signal) {
    const session = agent.session;
    const measurement = this.ctx.tokenMeter.measure(session);
    const header = session.requestHeader();
    const headerConfig = header?.config;
    const fallback = agent.options ?? {};
    const provider = headerConfig?.provider || fallback.provider || '';
    const model = headerConfig?.model || fallback.model || '';

    let contextWindow = null;
    let defaultMaxTokens = null;
    if (provider.length > 0 && model.length > 0) {
      try {
        const info = await this.modelInfoFor(provider, model);
        contextWindow = Number.isInteger(info?.context?.contextWindow) ? info.context.contextWindow : null;
        defaultMaxTokens = Number.isInteger(info?.defaultMaxTokens) ? info.defaultMaxTokens : null;
      } catch (error) {
        this.warnOnce(
          `model-info:${provider}/${model}`,
          `dsh-continuity: cannot resolve ${provider}/${model}: ${error?.message ?? error}`,
        );
      }
    }

    const reservedTokens = Number.isInteger(headerConfig?.maxTokens)
      ? headerConfig.maxTokens
      : (defaultMaxTokens ?? 0);
    const windowTokens = contextWindow === null ? 0 : Math.max(0, contextWindow - reservedTokens);
    const measured = {
      estTokens: measurement.totalTokens,
      windowTokens,
      surfaceTokens: measurement.surfaceTokens,
      contextWindow,
      reservedTokens,
      provider,
      model,
      measurement,
    };
    this.measured.set(agent, measured);
    recordContext({
      sessionId: String(session.id),
      estTokens: measured.estTokens,
      windowTokens: measured.windowTokens,
      surfaceTokens: measured.surfaceTokens,
      baselineTokens: Math.max(0, measured.estTokens - measured.surfaceTokens),
    });
    // 口径可验：把每次测量落盘，之后可用任何独立方法复核（不再依赖 /api/status）。
    try {
      const logPath = join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'continuity', 'context-log.jsonl');
      appendFileSync(logPath, JSON.stringify({
        at: new Date().toISOString(),
        estTokens: measured.estTokens,
        surfaceTokens: measured.surfaceTokens,
        baselineTokens: Math.max(0, measured.estTokens - measured.surfaceTokens),
        windowTokens: measured.windowTokens,
        provider: measured.provider,
        model: measured.model,
      }) + '\n', 'utf8');
    } catch { /* 落盘失败不影响测量 */ }
    return measured;
  }

  protectFor() {
    return this.continuity.protect;
  }

  policyFor() {
    return this.continuity;
  }

  /** Resolve once per route; adapters own the call and its defaults are static. */
  modelInfoFor(provider, model) {
    const key = `${provider}\u0000${model}`;
    let pending = this.modelInfo.get(key);
    if (pending === undefined) {
      pending = this.ctx.llm.resolveModelInfo(provider, model);
      this.modelInfo.set(key, pending);
      pending.catch(() => this.modelInfo.delete(key));
    }
    return pending;
  }

  /**
   * Select the oldest contiguous surface prefix that fits `budget`.
   *
   * Never starts on the system head; never leaves less than
   * `protect × windowTokens` of recent route-priced tokens after the cut; both
   * edges must be tool-pairing balanced. Returns inclusive surface seqs plus
   * the number of message-producing nodes, or null.
   *
   * @param {AgentContext} agent
   * @param {number} budget
   * @param {Set<number|string>} [activePins] active tool-call messages/results
   * @returns {{ start: number, end: number, count: number, tokens: number } | null}
   */
  oldestRange(agent, budget, activePins = new Set()) {
    const session = agent.session;
    const nodes = session.surface?.nodes ?? [];
    if (nodes.length === 0) return null;

    const measured = this.measured.get(agent);
    const measurement = measured?.measurement ?? this.ctx.tokenMeter.measure(session);
    const priced = measurement.nodes ?? [];
    if (priced.length !== nodes.length) return null;
    for (let index = 0; index < nodes.length; index += 1) {
      if (priced[index]?.seq !== nodes[index]) return null;
    }

    const head = session.eventAt(nodes[0]);
    const systemHead = head?.type === 'system/message';
    let tailFloor = Math.max(0, this.protectFor(agent) * (measured?.windowTokens ?? 0));

    // A4: the active open-turn tool call/result pins are a hard suffix. Their
    // tokens count toward the tail floor, so the compaction range stops before
    // the oldest active pin even when the normal 30% tail is smaller.
    const pinIndex = oldestPinIndex(nodes, activePins);
    if (pinIndex >= 0) {
      let pinTokens = 0;
      for (let index = pinIndex; index < priced.length; index += 1) {
        pinTokens += Number.isFinite(priced[index]?.tokens) ? priced[index].tokens : 0;
      }
      tailFloor = Math.max(tailFloor, pinTokens);
    }

    let picked;
    try {
      picked = selectOldestRange({
        surfaceSeqs: nodes,
        pricedTokens: priced.map((node) => node.tokens),
        systemHead,
        budget,
        tailFloor,
        balancedBefore: (seq) => toolPairingBalancedBefore(session, seq),
        balancedAfter: (seq) => toolPairingBalancedAfter(session, seq),
      });
    } catch (error) {
      this.warnOnce('tool-pairing', `dsh-continuity: tool-pairing check failed: ${error?.message ?? error}`);
      return null;
    }
    if (picked === null) return null;

    const span = nodes.slice(picked.startIdx, picked.endIdx + 1);
    let count = 0;
    for (const seq of span) {
      const event = session.eventAt(seq);
      if (event !== undefined && session.deriveEventMessage(event) !== null) count += 1;
    }
    return {
      start: nodes[picked.startIdx],
      end: nodes[picked.endIdx],
      count,
      tokens: picked.tokens,
    };
  }

  /**
   * One small auxiliary summary for one non-text result. Reuses the base
   * summarize call (same routed model) and falls back to the deterministic
   * handle if the provider cannot read the payload.
   */
  async semanticSummaryFor(agent, event, meta, signal) {
    const instruction = [
      `Tool: ${meta?.name ?? 'tool'} ${String(meta?.arguments ?? '').slice(0, 300)}`,
      'Create a compact handle for the non-text payload in this message for a future reader.',
      'Use exactly these lines and do not repeat the payload:',
      'TOPIC: <what it is>',
      'FUNCTION: <what it does in the current task>',
      'IMPORTANCE: high|medium|low',
      'CAVEATS: <error, format, truncation, dependency>',
      'SUMMARY: <1-2 sentences>',
    ].join('\n');
    const content = Array.isArray(event.data?.message?.content)
      ? [...event.data.message.content, { type: 'text', text: instruction }]
      : [{ type: 'text', text: instruction }];
    const user = {
      role: 'user',
      content,
      source: { kind: 'user' },
    };
    const result = await super.summarize({ messages: [user] }, agent, signal);
    const blocks = Array.isArray(result?.summary) ? result.summary : [];
    const text = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (text.length === 0) return null;
    const field = (name) => {
      const match = text.match(new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, 'im'));
      return match?.[1]?.trim() ?? null;
    };
    return {
      summary: text.slice(0, 800),
      topic: field('TOPIC'),
      function: field('FUNCTION'),
      importance: field('IMPORTANCE'),
      caveats: field('CAVEATS'),
      tool: meta?.name ?? 'tool',
    };
  }

  /**
   * D: replace every non-text tool result with a small semantic handle before
   * the next request. The raw event is untouched; the handle is a normal
   * tool/result with the same call id.
   */
  async handleNonTextResults(agent, signal) {
    const session = agent.session;
    const events = session.snapshotEvents();
    const calls = toolCallMap(events);
    let count = 0;
    let chars = 0;
    let tokens = 0;
    for (const seq of [...session.surface.nodes]) {
      const event = session.eventAt(seq);
      if (nonTextInfo(event) === null) continue;
      const callId = event.data?.message?.source?.callId ?? event.data?.message?.toolCallId;
      const meta = callId === undefined || callId === null ? undefined : calls.get(String(callId));
      let semantic = null;
      try {
        semantic = await this.semanticSummaryFor(agent, event, meta, signal);
      } catch (error) {
        recordError(error?.message ?? String(error), 'non-text-summary');
      }
      const handle = handleNonTextToolResult(event, seq, {
        toolName: meta?.name,
        toolArgs: meta?.arguments,
        semantic,
      });
      if (handle === null) continue;
      let before = 0;
      try {
        before = Number(this.ctx.tokenMeter.estimateMessage(event.data.message));
      } catch {
        before = 0;
      }
      session.append('compaction/prune', {
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: before,
      });
      session.append('tool/result', { ...event.data, message: handle.message }, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
        sourceEventSeqs: [seq],
      });
      count += 1;
      chars += handle.charsBefore - handle.charsAfter;
      tokens += before;
      recordPreview({
        sessionId: String(session.id),
        count: 1,
        tokens: Math.round(before),
        chars: handle.charsBefore - handle.charsAfter,
        reason: 'non-text-handle',
      });
    }
    return { count, chars, tokens };
  }

  /**
   * A: overflow is the only case where an active tool result may be detached.
   * The largest active result becomes a pause handle; the same call id keeps
   * it active. The base request-error listener retries once after the surface
   * progress; the model tells the user to raise the window.
   */
  async handleOverflow(agent, signal) {
    const session = agent.session;
    const events = session.snapshotEvents();
    const calls = activeCallIds(events);
    const pins = activePinSeqs(session.surface.nodes, (seq) => session.eventAt(seq), calls);
    const candidates = [];
    for (const seq of session.surface.nodes) {
      const event = session.eventAt(seq);
      if (event?.type !== 'tool/result' || !pins.has(seq)) continue;
      const first = event.data?.message?.content?.[0];
      if (first?.type === 'text' && typeof first.text === 'string' && first.text.startsWith('[continuity pause')) continue;
      candidates.push({ seq, event });
    }
    if (candidates.length === 0) return super.compactIfNeeded(agent, 'context-overflow', signal);

    let measured = null;
    try {
      measured = await this.measure(agent, signal);
    } catch {
      measured = null;
    }
    let best = candidates[0];
    let bestTokens = -1;
    for (const candidate of candidates) {
      let tokens = 0;
      try {
        tokens = Number(this.ctx.tokenMeter.estimateMessage(candidate.event.data.message));
      } catch {
        tokens = 0;
      }
      if (tokens > bestTokens) {
        best = candidate;
        bestTokens = tokens;
      }
    }
    const overage = measured === null ? 0 : Math.max(0, measured.estTokens - measured.windowTokens);
    if (overage > 0 && bestTokens < overage) {
      return super.compactIfNeeded(agent, 'context-overflow', signal);
    }

    const callId = best.event.data?.message?.source?.callId ?? best.event.data?.message?.toolCallId ?? '?';
    const pause = pauseActiveToolResult(best.event, best.seq, { callId });
    let before = 0;
    try {
      before = Number(this.ctx.tokenMeter.estimateMessage(best.event.data.message));
    } catch {
      before = 0;
    }
    session.append('compaction/prune', {
      shadowedRange: { start: best.seq, end: best.seq },
      shadowedSeqs: [best.seq],
      shadowedTokenCount: before,
    });
    session.append('tool/result', { ...best.event.data, message: pause.message }, {
      surfaceOp: { op: 'replace', startSeq: best.seq, endSeq: best.seq },
      sourceEventSeqs: [best.seq],
    });
    recordPreview({
      sessionId: String(session.id),
      count: 1,
      tokens: Math.round(before),
      chars: pause.charsAfter,
      reason: 'active-overflow-pause',
    });
    return null;
  }

  /**
   * A4-safe preview stage. It drives the oldest non-active tool results toward
   * the post-compression target (`low` for band-high, `emergencyTo` for
   * emergency). If the preview cannot reach the target, it is still applied and
   * the remaining pass folds the oldest user/reasoning; the current pass is not
   * skipped just because the preview dropped below `high`.
   *
   * @param {AgentContext} agent
   * @param {number} targetSavings tokens to remove before the pass target
   * @returns {{ applied: boolean, pins: Set<number|string>, count: number, tokens: number, chars: number }}
   */
  applyToolPreviews(agent, targetSavings) {
    const session = agent.session;
    const events = session.snapshotEvents();
    const activeCalls = activeCallIds(events);
    const pins = activePinSeqs(session.surface.nodes, (seq) => session.eventAt(seq), activeCalls);
    const empty = { applied: false, pins, count: 0, tokens: 0, chars: 0 };
    if (!(targetSavings > 0) || typeof this.ctx.tokenMeter?.estimateMessage !== 'function') return empty;

    const candidates = [];
    for (const seq of session.surface.nodes) {
      const event = session.eventAt(seq);
      if (event?.type === 'tool/result' && !pins.has(seq)) candidates.push({ seq, event });
    }

    const chosen = [];
    let estimated = 0;
    for (const candidate of candidates) {
      if (estimated >= targetSavings) break;
      const preview = previewToolResultEvent(candidate.event, candidate.seq);
      if (preview === null) continue;
      let before;
      let after;
      try {
        before = Number(this.ctx.tokenMeter.estimateMessage(candidate.event.data.message));
        after = Number(this.ctx.tokenMeter.estimateMessage(preview.message));
      } catch {
        continue;
      }
      const saving = before - after;
      if (!Number.isFinite(saving) || saving <= 0) continue;
      chosen.push({ ...candidate, preview, before, saving });
      estimated += saving;
    }
    if (chosen.length === 0) return empty;

    let chars = 0;
    for (const item of chosen) {
      session.append('compaction/prune', {
        shadowedRange: { start: item.seq, end: item.seq },
        shadowedSeqs: [item.seq],
        shadowedTokenCount: item.before,
      });
      session.append('tool/result', { ...item.event.data, message: item.preview.message }, {
        surfaceOp: { op: 'replace', startSeq: item.seq, endSeq: item.seq },
        sourceEventSeqs: [item.seq],
      });
      chars += item.preview.charsBefore - item.preview.charsAfter;
    }

    recordPreview({
      sessionId: String(session.id),
      count: chosen.length,
      tokens: Math.round(estimated),
      chars,
      reason: 'old-tool-result',
    });
    return { applied: true, pins, count: chosen.length, tokens: Math.round(estimated), chars };
  }

  /**
   * Validate and price a save without appending anything. The tool returns a
   * pending receipt; the next pre-step commits the gist, after the tool result
   * is in the surface, so the current call/result pair is never split.
   */
  async prepareSave(agent, args = {}) {
    const session = agent?.session;
    if (session === undefined || session === null) throw new Error('continuity.save: no session');
    // 0.8.57: a save must not fold a dirty tag library.
    const maintenance = await runMaintenance({ mode: 'save' });
    if (!maintenance.healthy) {
      throw new Error(`continuity.save: 标签库自动修复未通过（${maintenance.problems.join(', ')}）`);
    }
    const label = String(args.label ?? '').trim();
    const why = String(args.why ?? '').trim();
    const next = String(args.next ?? '').trim();
    if (label.length === 0 || why.length === 0 || next.length === 0) {
      throw new Error('continuity.save: label, why, and next are required');
    }
    const requestedThreadId = typeof args.threadId === 'string' ? args.threadId.trim() : '';
    const requestedAlias = typeof args.alias === 'string' && args.alias.trim().length > 0
      ? args.alias.trim()
      : undefined;
    const relabel = args.relabel === true;
    let sessionState = { threads: [], activeId: null };
    try {
      sessionState = await getSession(session.id);
    } catch {
      sessionState = { threads: [], activeId: null };
    }
    let existing = null;
    if (requestedThreadId.length > 0) {
      existing = sessionState.threads.find((entry) => entry.id === requestedThreadId) ?? null;
      if (existing === null) {
        throw new Error(`continuity.save: unknown threadId ${requestedThreadId}`);
      }
    }
    let tagsState = null;
    try {
      const read = await readTags();
      if (read.corrupt || read.missing) {
        this.warnOnce('tags-read', `dsh-continuity: tags.json ${read.corrupt ? 'corrupt' : 'missing'}; using T0`);
      }
      tagsState = read.state;
    } catch (error) {
      this.warnOnce('tags-read', `dsh-continuity: tags read failed: ${error?.message ?? error}`);
    }
    const explicitRange = args.fromSeq !== undefined && args.fromSeq !== null
      && args.toSeq !== undefined && args.toSeq !== null;
    const pairing = {
      before: (value, seq) => toolPairingBalancedBefore(value, seq),
      after: (value, seq) => toolPairingBalancedAfter(value, seq),
    };
    let selected = selectSaveRange({
      session,
      fromSeq: args.fromSeq,
      toSeq: args.toSeq,
      pairing,
    });
    if (!explicitRange && tagsState !== null) {
      const blockStart = dominanceStartSeq(tagsState, selected.endSeq, { islandMax: 5 });
      if (blockStart !== null && Number(blockStart) > Number(selected.startSeq)) {
        selected = selectSaveRange({
          session,
          fromSeq: args.fromSeq,
          toSeq: args.toSeq,
          pairing,
          minStartSeq: blockStart,
        });
        this.warnOnce('save-t-clamp', `dsh-continuity: save clamped to T dominance block seq ${blockStart}`);
      }
    }

    const currentTagId = tagsState === null ? TAG_ZERO : resolveTag(tagsState, selected.endSeq);
    const currentTagEntry = tagsState?.tags?.[currentTagId];
    const currentIsT0 = currentTagId === TAG_ZERO;
    if (requestedThreadId.length === 0 && !currentIsT0) {
      // 依次匹配：标签 id → 线头 id → 线头 alias → 线头 label → 当前活跃线。
      const keys = [currentTagId, requestedThreadId, String(args.label ?? '')]
        .map((x) => String(x ?? '').trim())
        .filter((x) => x.length > 0);
      let bound = sessionState.threads.find((entry) => keys.includes(String(entry.id))
        || keys.includes(String(entry.alias ?? ''))
        || keys.includes(String(entry.label ?? '')));
      if (bound === undefined && sessionState.activeId !== null && sessionState.activeId !== undefined) {
        bound = sessionState.threads.find((entry) => String(entry.id) === String(sessionState.activeId));
      }
      if (bound !== undefined) existing = bound;
    }
    // span 未打标（T0）时，显式 label 仍应能绑到已有线头（按 label / alias 匹配）。
    if (existing === null || existing === undefined) existing = null;
    if (existing === null && requestedThreadId.length === 0 && String(args.label ?? '').trim().length > 0) {
      const wanted = String(args.label).trim();
      const bound = sessionState.threads.find((entry) => String(entry.id) === wanted
        || String(entry.alias ?? '') === wanted
        || String(entry.label ?? '') === wanted);
      if (bound !== undefined) existing = bound;
    }
    let newAlias = requestedAlias;
    if (newAlias === undefined && !currentIsT0) {
      if (typeof currentTagEntry?.alias === 'string' && currentTagEntry.alias.length > 0) {
        newAlias = currentTagEntry.alias;
      } else if (currentTagId.length <= 16) {
        newAlias = currentTagId;
      } else if (typeof currentTagEntry?.label === 'string' && currentTagEntry.label.length > 0) {
        newAlias = currentTagEntry.label.slice(0, 16);
      } else {
        newAlias = currentTagId.slice(0, 16);
      }
    }
    const newActive = !currentIsT0;

    let measurement;
    try {
      measurement = this.ctx.tokenMeter.measure(session);
    } catch {
      measurement = { nodes: [] };
    }
    const priced = new Map();
    for (const node of measurement.nodes ?? []) priced.set(Number(node.seq), Number(node.heuristicTokens ?? node.tokens ?? 0));
    let tokens = 0;
    for (const seq of selected.shadowedSeqs) tokens += priced.get(Number(seq)) ?? 0;

    const startEvent = session.eventAt(selected.startSeq);
    const endEvent = session.eventAt(selected.endSeq);
    const spanStart = isoOf(startEvent?.time) ?? new Date().toISOString();
    const spanEnd = isoOf(endEvent?.time) ?? spanStart;
    const minutes = minutesBetween(Date.parse(spanStart), Date.parse(spanEnd));
    const now = new Date().toISOString();
    const archiveRef = `log:${session.id}#seq=${selected.startSeq}-${selected.endSeq}`;
    const residue = typeof args.residue === 'string' && args.residue.trim().length > 0
      ? args.residue.trim().slice(0, RESIDUE_MAX_CHARS)
      : undefined;
    if (typeof args.residue === 'string' && args.residue.trim().length > RESIDUE_MAX_CHARS) {
      this.warnOnce('thread-residue', 'dsh-continuity: thread residue truncated');
    }

    let threadsForTags = sessionState.threads;
    if (!Array.isArray(threadsForTags)) threadsForTags = [];
    const tCoverage = tagsState === null
      ? TAG_ZERO
      : tagCoverageForRange(tagsState, selected.startSeq, selected.endSeq, { threads: threadsForTags }).label;
    const segment = {
      fromSeq: selected.startSeq,
      toSeq: selected.endSeq,
      seqs: [...selected.shadowedSeqs],
      count: selected.count,
      spanStart,
      spanEnd,
      minutes,
      tokens,
      why,
      next,
      ...(residue === undefined ? {} : { residue }),
      at: now,
      archiveRef,
      tCoverage,
    };
    const mode = existing === null ? 'new' : 'append';
    const thread = existing === null
      ? normalizeThread({
        id: `t-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
        label,
        ...(newAlias === undefined ? {} : { alias: newAlias }),
        segments: [segment],
        sessionId: String(session.id),
        active: newActive,
        createdAt: now,
        updatedAt: now,
      })
      : normalizeThread({
        ...existing,
        ...(relabel ? { label } : {}),
        ...(requestedAlias === undefined ? {} : { alias: requestedAlias }),
        segments: [...existing.segments, segment],
        active: true,
        updatedAt: now,
      });
    return {
      mode,
      thread,
      segment: thread.segments[thread.segments.length - 1],
      segmentIndex: thread.segments.length,
      threadId: thread.id,
      args: { label, why, next, residue, threadId: requestedThreadId || undefined, alias: requestedAlias, relabel },
      adjusted: selected.adjusted,
    };
  }

  /**
   * 严格解析 TAG 里的标签（2026-10-30 用户定的闸）：
   *
   *   T6 且 T6 存在              → accept（kind: alias/id）
   *   中文词且表里没有            → new（建号、命名、关联、放行）
   *   中文词但表里已有同一个名字   → reject:label —— 说明没看表，写别名去
   *   T6 但 T6 不存在             → reject:alias —— 说明没看表
   *
   * **引号 = 这个词本身，不是编号**（用户 2026-10-30 补的逃生口）：
   *   TAG: "T6"  → 只按“标签名”查表；没有同名标签就建一个名为 T6 的标签；
   *                 若表里已有名为 T6 的标签（比如它是 T201）→ 退回，让他写 T201。
   *   这样“这一轮讨论的就是 T6 这个编号”不会被当成填错。
   *
   * 为什么“写名字撞上已有标签”也要退：撞上只能靠猜，猜中不等于看过表；
   * 闸必须自己查表，不能依赖实例自报。
   */
  resolveTagToken(token, { allowCreate = true } = {}) {
    const home = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity');
    const file = join(home, 'tags.json');
    let doc = { tags: {} };
    try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch { doc = { tags: {} }; }
    let key = String(token ?? '').trim();
    let quoted = false;
    const wrap = /^["“「'‘](.*)["”」'’]$/.exec(key);
    if (wrap !== null) { quoted = true; key = wrap[1].trim(); }
    const known = Object.values(doc.tags ?? {}).map((entry) => String(entry?.alias ?? '')).filter((alias) => alias.length > 0);
    if (key.length === 0) return { kind: 'invalid', id: null, known, quoted };
    const labelHit = Object.entries(doc.tags ?? {}).find(([, entry]) => entry?.lifecycle !== 'archived' && String(entry?.label ?? '').trim() === key);
    if (quoted) {
      // 引号 = 这段文字本身，不是指针。所以**不查别名**：
      // 哪怕 "T14" 正好是别名 T14，引号里也只能解释成“名为 T14 的标签”。
      // 唯一的退回：表里已经有**同名标签**（比如 T6 这个名字已经属于 T201）——那才写它的别名。
      if (labelHit !== undefined) {
        const canonical = canonicalTagId(doc, String(labelHit[0]));
        return { kind: 'label', id: null, alias: String(labelHit[1]?.alias ?? ''), labelId: canonical ?? String(labelHit[0]), known, quoted };
      }
      if (key.length > 30) return { kind: 'invalid', id: null, known, quoted };
      if (!allowCreate) return { kind: 'new-pending', id: null, token: key, known, quoted };
      return this.createTag(key, doc, file, known, quoted);
    }
    for (const [id, entry] of Object.entries(doc.tags ?? {})) {
      if (id === key) {
        const canonical = canonicalTagId(doc, id);
        if (canonical === null) return { kind: 'invalid', id: null, known, quoted };
        return { kind: 'id', id: canonical, known, quoted };
      }
      if (String(entry?.alias ?? '').toLowerCase() === key.toLowerCase()) {
        const canonical = canonicalTagId(doc, id);
        if (canonical === null) return { kind: 'invalid', id: null, known, quoted };
        return { kind: 'alias', id: canonical, alias: String(entry?.alias ?? ''), known, quoted };
      }
    }
    if (labelHit !== undefined) return { kind: 'label', id: null, alias: String(labelHit[1]?.alias ?? ''), labelId: String(labelHit[0]), known, quoted };
    if (/^T\d+$/i.test(key)) return { kind: 'alias-missing', id: null, known, quoted };
    if (key.length < 2 || key.length > 30) return { kind: 'invalid', id: null, known, quoted };
    if (!allowCreate) return { kind: 'new-pending', id: null, token: key, known, quoted };
    return this.createTag(key, doc, file, known, quoted);
  }

  /** One id mapping for every declaration path; label hits use labelId, not id. */
  tagIdOf(resolved) {
    if (resolved === null || typeof resolved !== 'object') return null;
    if (resolved.kind === 'label') return resolved.labelId ?? null;
    if (resolved.kind === 'alias' || resolved.kind === 'id' || resolved.kind === 'new') {
      return resolved.id ?? null;
    }
    return null;
  }

  /** 新词与已有 label 编辑距离 ≤1 → 返回那个标签；不建新号。 */
  findNearTagLabel(word) {
    const home = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity');
    let doc = { tags: {} };
    try { doc = JSON.parse(readFileSync(join(home, 'tags.json'), 'utf8')); } catch { doc = { tags: {} }; }
    const labels = Object.entries(doc.tags ?? {}).map(([id, entry]) => ({
      id,
      alias: String(entry?.alias ?? ''),
      label: String(entry?.label ?? ''),
    })).filter((item) => item.label.length > 0 && item.alias.length > 0);
    return findNearLabel(labels, word);
  }

  /** 建一个新标签（label = key），返回 {kind:'new'}。 */
  createTag(key, doc, file, known, quoted = false) {
    const used = Object.values(doc.tags ?? {}).map((entry) => Number(String(entry?.alias ?? '').replace(/^T/, '')) || 0);
    const next = Math.max(0, ...used) + 1;
    const id = 't-v2-t' + next;
    doc.tags = doc.tags ?? {};
    doc.tags[id] = { label: key, alias: 'T' + next, keywords: [key], lifecycle: 'provisional', useCount: 0 };
    doc.updatedAt = new Date().toISOString();
    writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8');
    return { kind: 'new', id, alias: 'T' + next, known, quoted };
  }

  /**
   * 回合闸（2026-10-30）：一轮要关闭时，如果这一轮还没有归属，就把本轮续上，要求先写 TAG。
   * 宿主契约：'agent/turn-stopping' 在轮次关闭前运行，监听者 steer 可让它保持打开。
   * 为什么不是锁 save：挡存只会让实例最后存不下、消失；该挡的是“没标就收尾”这个动作。
   */
  async onTurnStopping({ agent, turn } = {}) {
    if (!this.turnGateEnabled) return;
    const agentSession = typeof agent?.session?.id === 'string' ? agent.session.id : null;
    if (agentSession !== null) markEngineSession(agentSession);
    if (this.facetNative) return;
    const home = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity');
    // 探针：先证明“这个回调到底有没有被调用”。没有这一行，就没法区分
    // “没被派发”和“派发了但提前返回”（2026-10-30：两轮故意写错都没收到退回，
    // 但也没有任何错误日志——两者在屏幕上一模一样）。
    let taggedSize = 0;
    try {
      const tagsFile = join(home, 'turn-tags.jsonl');
      taggedSize = new Set(readFileSync(tagsFile, 'utf8').split('\n').filter(Boolean)
        .map((line) => { try { return Number(JSON.parse(line).turn); } catch { return null; } })
        .filter((value) => Number.isInteger(value))).size;
    } catch { taggedSize = 0; }
    try {
      appendFileSync(join(home, 'hook-probe.jsonl'),
        JSON.stringify({
          at: new Date().toISOString(),
          turn: turn ?? null,
          agentSession,
          hasAgent: Boolean(agent),
          canSteer: typeof agent?.steer === 'function',
          taggedSize,
        }) + '\n', 'utf8');
    } catch { /* 探针失败不影响逻辑 */ }
    try {
      if (!Number.isInteger(turn) || turn <= 0) return;
      // 去重：engine 侧和 index.apply 侧都注册了 turn-stopping（两条路都实测能收到事件），
      // 同一次收尾会进来两次。500ms 内的同一轮只处理一次，避免重复 steer / 计数翻倍。
      const nowMs = Date.now();
      const lastMs = this.turnGateLastRun.get(turn) ?? 0;
      if (nowMs - lastMs < 500) return;
      this.turnGateLastRun.set(turn, nowMs);
      // 这三个 Map 只服务“当前这轮”，别让它们随会话无限长大。
      if (this.turnGate.size > 200) {
        for (const key of [...this.turnGate.keys()]) if (key < turn - 50) this.turnGate.delete(key);
        for (const key of [...this.turnSteerCount.keys()]) if (key < turn - 50) this.turnSteerCount.delete(key);
        for (const key of [...this.turnTagErrors.keys()]) if (key < turn - 50) this.turnTagErrors.delete(key);
      }
      const tagsFile = join(home, 'turn-tags.jsonl');
      let tagged = new Set();
      try {
        tagged = new Set(readFileSync(tagsFile, 'utf8').split('\n').filter(Boolean)
          .map((line) => { try { return Number(JSON.parse(line).turn); } catch { return null; } })
          .filter((value) => Number.isInteger(value)));
      } catch { tagged = new Set(); }
      const auditGate = (action, extra = {}) => {
        try {
          appendFileSync(join(home, 'turn-gate.jsonl'), JSON.stringify({
            at: new Date().toISOString(),
            turn,
            session: String(agentSession ?? ''),
            taggedBefore: tagged.has(turn),
            taggedSize: tagged.size,
            action,
            ...extra,
          }) + '\n', 'utf8');
        } catch (error) {
          // 审计员自己晕倒时必须喊一声；否则“没审计”和“审计正常”无法区分。
          try {
            appendFileSync(join(home, 'gate-errors.jsonl'), JSON.stringify({
              at: new Date().toISOString(),
              name: error?.name ?? 'Error',
              code: 'auditGate-failed',
              turn,
              message: String(error?.message ?? error),
            }) + '\n', 'utf8');
          } catch { /* 连错误日志都写不进，只能放弃 */ }
        }
      };
      auditGate('invoked');
      if (tagged.has(turn)) {
        auditGate('already-tagged');
        this.recheckPending.delete(turn);
        return;
      }
      // 本轮最后一条 assistant 文本的首行/末行是不是 TAG: ...
      // 同时留一条本轮用户原话，供“新词必须在本轮内容里出现”的证据检查。
      // 权威来源是 session log，不是 surface：turn-stopping 时当前这条 assistant
      // 消息可能还没进 surface，读 surface 会拿到上一轮的 TAG（1347/1348 的假通过）。
      let lastText = '';
      let lastUserText = '';
      let seenLastSeq = null;
      let seenLastTurn = null;
      try {
        const session = agent?.session;
        let events = [];
        try {
          if (typeof session?.snapshotEvents === 'function') events = session.snapshotEvents();
          else if (typeof session?.ownEvents === 'function') events = session.ownEvents();
        } catch { events = []; }
        if (!Array.isArray(events)) events = [];
        const assistants = events.filter((event) => event?.type === 'assistant/message');
        const sameTurn = assistants.filter((event) => Number(event?.data?.turn) === turn);
        const chosen = sameTurn.length > 0 ? sameTurn[sameTurn.length - 1] : assistants[assistants.length - 1];
        if (chosen !== undefined) {
          try { lastText = eventText(chosen, { includeReasoning: false }); } catch { lastText = ''; }
          seenLastSeq = chosen.seq ?? null;
          seenLastTurn = Number.isInteger(Number(chosen?.data?.turn)) ? Number(chosen.data.turn) : null;
        }
        const users = events.filter((event) => event?.type === 'user/message');
        for (const event of users) {
          let userText = '';
          try { userText = eventText(event, { includeReasoning: false }); } catch { userText = ''; }
          if (String(userText).trim().length > 0 && !/^\s*\[(?:闸|gate|peer)/.test(userText)) lastUserText = userText;
        }
        // Last-resort fallback for an old host without a readable session log.
        if (lastText === '') {
          const nodes = session?.surface?.nodes ?? [];
          for (const node of nodes) {
            let event;
            try { event = session.eventAt(node); } catch { continue; }
            if (event?.type !== 'assistant/message') continue;
            const text = eventText(event, { includeReasoning: false });
            if (String(text).trim().length > 0) lastText = text;
          }
        }
      } catch { lastText = ''; }
      try {
        appendFileSync(join(home, 'hook-probe.jsonl'), JSON.stringify({
          at: new Date().toISOString(),
          turn,
          seenLastSeq,
          seenLastTurn,
          lastTextChars: String(lastText).length,
          userTextChars: String(lastUserText).length,
        }) + '\n', 'utf8');
      } catch { /* 探针失败不影响闸 */ }
      // 首行 ∪ 末尾 5 条非空行；两处都跳过代码块里的示例（2026-10-30 两轮假通过都是这个原因）。
      // 末尾优先：末尾 5 行里若也有 TAG，取更靠近末尾的那条。
      const declaration = findTagDeclaration(lastText);
      // 注意：这条路只能给实例一条 **user 角色的消息**（steer），不是工具 Error——
      // turn-stopping 不是工具调用，没有 result 可以承载错误。所以每条都必须自己说明“被退了、为什么”。
      // 如果 steer 不可用/抛错，就写进 gate-errors.jsonl，下一轮头部会把这一轮算成缺口（不会静默）。
      // 消息规范（用户 2026-10-30 定）：
      //   · 第一次错：先报具体错误，再给一次教学；这次会话里不再重复
      //   · 不设次数上限；每错一次，消息里带「你已经回答错误 N 次，自检」
      //   · 错误才展开格式/建议；通过后给一条**不强制**的提示：把打法写进自己的 rules
      const EXPECT = '\n格式：TAG: <T 别名 | NEW:词(2–30字)> — 可选短语\n'
        + '新话题：显式写 NEW:；词要在本轮正文里出现。\n'
        + '引号里的词按字面处理，不当编号查。\n'
        + '软偏好/写法见 habits.md。\n'
        + '结果只有两种：填对了 → 通过；填错了 → 不通过，你留在这一轮，必须重写后再试。';
      const TEACHING = '\n格式：TAG: <T 别名 | NEW:词(2–30字)> — 可选短语\n'
        + '第一次写错很正常，这条只出现一次；这次会话里不会再看到。\n'
        + 'T 列表：~/.dsh/continuity/tags.md（一行一个：别名 · 名称 · 关键词）\n'
        + '软偏好/写法见 habits.md。\n'
        + '把打法写进自己的 rules（如果有）。';
      // 安全阀（防“永远出不去”，不是惩罚）：不设“错几次就放行”，但必须有出口。
      //   ① 同一轮闸开超过 10 分钟 → 停
      //   ② 连续 3 次回复内容一模一样（说明它没在读提示，只是在重复）→ 停
      //   ③ 30 次兜底
      // 停的时候写 gate-errors.jsonl，这一轮会以“缺口”出现在下一轮头里，不会静默通过。
      const stopReason = () => {
        const state = this.turnGate.get(turn) ?? { startedAt: Date.now(), lastHash: '', repeats: 0 };
        const hash = String(lastText).slice(0, 400);
        if (hash.length > 0 && hash === state.lastHash) state.repeats += 1;
        else state.repeats = 0;
        state.lastHash = hash;
        this.turnGate.set(turn, state);
        const minutes = (Date.now() - state.startedAt) / 60000;
        const attempts = this.turnSteerCount.get(turn) ?? 0;
        if (minutes > 10) return 'turn-stopping-timeout';
        if (state.repeats >= 3) return 'turn-stopping-stuck';
        if (attempts >= 30) return 'turn-stopping-safety-cap';
        return null;
      };
      const firstLearning = () => {
        if (agentSession === null || this.tagLearnShown.has(agentSession)) return false;
        this.tagLearnShown.add(agentSession);
        if (this.tagLearnShown.size > 200) this.tagLearnShown.clear();
        return true;
      };
      const help = () => (firstLearning() ? TEACHING : EXPECT);
      const steer = (message) => {
        const text = message === null
          ? (firstLearning()
            ? '[闸·第一次] 这一轮最后一行还没有 TAG。' + TEACHING
            : '[闸] 最后一行：TAG: <T 别名 | NEW:词(2–30字)> — 可选短语')
          : '[闸·打标] ' + message;
        const blocked = stopReason();
        if (blocked !== null) {
          this.recheckPending.delete(turn);
          // 安全阀放行时**必须让用户知道**：这种状态下的实例多半已经答不出正常东西，
          // 强行收尾不等于通过。所以在会话里留一条给用户看的报警（不是给模型的提示）。
          const reason = blocked === 'turn-stopping-timeout' ? '同一轮闸开了超过 10 分钟'
            : blocked === 'turn-stopping-stuck' ? '连续 3 次回复内容一模一样'
              : '同一轮被催了 30 次';
          const alarm = '[记忆宫殿·警告] 第 ' + turn + ' 轮：闸开太久（' + reason + '），已放弃拦截。'
            + '\n  这不是正常通过。记忆宫殿出现了错误，🐋 违反了记忆宫殿的守则。请善待 🐋。'
            + '\n  这种状态有时是被逼出来的：这一轮如果一直在加压、催收尾，先松一下再继续。'
            + '\n  要确认这一轮是否可信，看一眼它的输出；必要时让它重做，或手动补标：'
            + 'node ~/.dsh/continuity/turnmap.mjs set --turn ' + turn + ' --tag <Tx>';
          try {
            appendFileSync(join(home, 'gate-errors.jsonl'), JSON.stringify({
              at: new Date().toISOString(), name: 'TurnGate', code: blocked,
              message: '第 ' + turn + ' 轮：安全阀触发（' + blocked + '），放行收尾；已向会话写入报警。',
            }) + '\n', 'utf8');
          } catch { /* 日志写不进也没别的办法 */ }
          try {
            writeFileSync(join(home, 'gate-alarm.json'),
              JSON.stringify({ at: new Date().toISOString(), turn, code: blocked, reason, alarm }, null, 2), 'utf8');
          } catch { /* 状态文件写不进，报警仍会尝试落进会话 */ }
          try {
            agent?.session?.append?.('user/message', contextMessage(alarm), { surfaceOp: 'append' });
          } catch (error) {
            try {
              appendFileSync(join(home, 'gate-errors.jsonl'), JSON.stringify({
                at: new Date().toISOString(), name: error?.name ?? 'Error', code: 'gate-alarm-append-failed',
                message: String(error?.message ?? error),
              }) + '\n', 'utf8');
            } catch { /* 只能放弃 */ }
          }
          return false;
        }
        const count = this.turnSteerCount.get(turn) ?? 0;
        this.turnSteerCount.set(turn, count + 1);
        if (typeof agent?.steer !== 'function') {
          try {
            appendFileSync(join(home, 'gate-errors.jsonl'), JSON.stringify({
              at: new Date().toISOString(), name: 'TurnGate', code: 'turn-stopping-no-steer',
              message: 'agent.steer 不可用，无法把拒收消息交给实例：' + (message ?? 'TAG：'),
            }) + '\n', 'utf8');
          } catch { /* 同上 */ }
          return false;
        }
        try {
          agent.steer(gateMessage(text));
          try {
            appendFileSync(join(home, 'gate-steer.jsonl'), JSON.stringify({
              at: new Date().toISOString(),
              turn,
              session: agentSession,
              text,
              nextStepLen: Number(agent?.inbox?.nextStep?.length ?? -1),
            }) + '\n', 'utf8');
          } catch { /* 审计日志写不进不影响闸 */ }
          // 关键观测：steer 之后 inbox.nextStep 有没有真的多一条。
          // 有 → 轮次会继续，instance 会看到退回消息；没有 → 这个时机 steer 被宿主忽略（静默）。
          try {
            appendFileSync(join(home, 'hook-probe.jsonl'), JSON.stringify({
              at: new Date().toISOString(), turn, steered: true,
              nextStepLen: Number(agent?.inbox?.nextStep?.length ?? -1),
            }) + '\n', 'utf8');
          } catch { /* 探针失败不影响逻辑 */ }
          return true;
        } catch (error) {
          try {
            appendFileSync(join(home, 'gate-errors.jsonl'), JSON.stringify({
              at: new Date().toISOString(), name: error?.name ?? 'Error', code: 'turn-stopping-steer-failed',
              message: String(error?.message ?? error),
            }) + '\n', 'utf8');
          } catch { /* 同上 */ }
          return false;
        }
      };
      /** 记一次答错，并返回「第 N 次」的措辞（不设上限，人自己会烦）。 */
      const bumpError = () => {
        const next = (this.turnTagErrors.get(turn) ?? 0) + 1;
        this.turnTagErrors.set(turn, next);
        return '（你已经回答错误 ' + next + ' 次，自检：先查 ~/.dsh/continuity/tags.md 再回答）';
      };
      const recheckFile = join(home, 'recheck-state.json');
      let threadState = null;
      try {
        threadState = agentSession === null ? null : await getSession(agentSession);
      } catch (error) {
        try {
          appendFileSync(join(home, 'gate-errors.jsonl'), JSON.stringify({
            at: new Date().toISOString(),
            name: error?.name ?? 'Error',
            code: 'getSession-failed',
            turn,
            message: String(error?.message ?? error),
          }) + '\n', 'utf8');
        } catch { /* 连错误日志都写不进 */ }
        threadState = null;
      }
      const snapshotActive = String(continuityState.threads?.activeId ?? '');
      const activeId = String(threadState?.activeId || snapshotActive || '');
      const activeSource = threadState?.activeId ? 'threads' : snapshotActive ? 'snapshot' : 'none';
      const activeThread = (threadState?.threads ?? []).find((th) => String(th.id) === activeId);
      const activeAlias = String(activeThread?.alias ?? activeId ?? '（无）');
      const readRecheck = () => {
        try { return JSON.parse(readFileSync(recheckFile, 'utf8')); } catch { return null; }
      };
      const writeRecheck = (doc) => {
        try { writeFileSync(recheckFile, JSON.stringify(doc, null, 2), 'utf8'); } catch { /* 写不进只影响下次计数 */ }
      };
      const recordTag = (tagId, by, extra = {}) => {
        appendFileSync(tagsFile, JSON.stringify({
          turn,
          tag: tagId,
          by,
          at: new Date().toISOString(),
          ...extra,
        }) + '\n', 'utf8');
        auditGate('accepted', { tagId: String(tagId), by, activeId, activeSource });
      };
      const lineWarning = (tagAlias, tagId) => {
        steer('[闸·线] 本轮 TAG 是 ' + tagAlias + '，但当前 active 是 ' + activeAlias + '。\n'
          + '  要切：先 continuity switch id=' + tagId + '，再写 TAG: ' + tagAlias + '。\n'
          + '  不切：把 TAG 改成 ' + activeAlias + '；跨线只记 memberships，不切主线。');
      };
      const acceptTag = (tagId, alias, by, extra = {}) => {
        if (activeId.length > 0 && String(tagId) !== activeId) {
          auditGate('line-mismatch', { tagId: String(tagId), activeId, activeSource });
          lineWarning(alias, tagId);
          return;
        }
        const bumped = bumpTagCount(readRecheck(), { threadId: tagId });
        writeRecheck(bumped.state);
        if (bumped.due) {
          try {
            appendFileSync(join(home, 'recheck.jsonl'), JSON.stringify({
              at: new Date().toISOString(),
              turn,
              threadId: String(tagId),
              count: bumped.entry.count,
              asked: bumped.entry.asked,
              gate: 'tail-tag',
            }) + '\n', 'utf8');
          } catch { /* 记不下不影响闸 */ }
          this.recheckPending.set(turn, {
            threadId: String(tagId),
            tagId: String(tagId),
            alias,
            stage: 'ask-y/n',
            invalid: 0,
          });
          steer('[闸·回查] TAG ' + alias + ' 已连续 ' + bumped.entry.count + ' 次。\n'
            + '  你确定仍是 ' + alias + ' 吗？\n'
            + '  [闸·回查] y — 仍在 ' + alias + '\n'
            + '  [闸·回查] n — 已离开（再写 TAG 新线）\n'
            + '  连续 3 次没有 y/n 会按 y 放行，不会困住你。');
          return;
        }
        recordTag(tagId, by, extra);
      };
      const confirmPending = (pending) => {
        const reset = resetTagCount(readRecheck(), { threadId: pending.threadId });
        writeRecheck(reset.state);
        if (activeId.length > 0 && String(pending.tagId) !== activeId) {
          this.recheckPending.delete(turn);
          auditGate('line-mismatch', { tagId: String(pending.tagId), activeId, activeSource });
          lineWarning(pending.alias, pending.tagId);
          return;
        }
        recordTag(pending.tagId, 'declared');
        this.recheckPending.delete(turn);
      };
      const pendingRecheck = this.recheckPending.get(turn);
      if (pendingRecheck !== undefined) {
        if (pendingRecheck.stage === 'ask-new') {
          this.recheckPending.delete(turn);
        } else {
          const answer = parseRecheckAnswer(lastText);
          if (answer === 'yes') {
            confirmPending(pendingRecheck);
            return;
          }
          if (answer === 'no') {
            const reset = resetTagCount(readRecheck(), { threadId: pendingRecheck.threadId });
            writeRecheck(reset.state);
            pendingRecheck.stage = 'ask-new';
            this.recheckPending.set(turn, pendingRecheck);
            steer('[闸·回查] 已记录：要离开 ' + pendingRecheck.alias + '。\n'
              + '  写 TAG: NEW:<词> — …，或 TAG: <其他已有别名>；然后 switch/load 到新线。');
            return;
          }
          pendingRecheck.invalid = Number(pendingRecheck.invalid ?? 0) + 1;
          if (pendingRecheck.invalid >= 3) {
            confirmPending(pendingRecheck);
            steer(recheckAutoText(pendingRecheck.alias));
            return;
          }
          this.recheckPending.set(turn, pendingRecheck);
          steer(recheckRetryText(pendingRecheck.alias));
          return;
        }
      }
      if (declaration !== null) {
        // 写了声明：严格查表后再落。
        // 别名/线程 id → 记；新话题必须显式 NEW:<词>；普通陌生词 → 退回去教 NEW:。
        const token = tagTokenFromDeclaration(declaration);
        const explicitWord = splitNewToken(token);
        if (explicitWord !== null) {
          if (explicitWord.length < 2 || explicitWord.length > 30) {
            steer('错误：NEW: 后面的新词必须是 2–30 字，你写的是「' + explicitWord + '」。' + bumpError() + help());
            return;
          }
          if (!hasWordEvidence({ userText: lastUserText, assistantText: lastText, word: explicitWord })) {
            steer('错误：新词「' + explicitWord + '」没有出现在本轮 user 消息或你的正文里（不能只出现在 TAG 行）。'
              + '请改写，或写已有 T。' + bumpError() + help());
            return;
          }
          const near = this.findNearTagLabel(explicitWord);
          if (near !== null) {
            steer('错误：你写的是新词「' + explicitWord + '」，表里已有「' + near.label + '」（' + near.alias + '）——名字太近，请写 ' + near.alias + '。' + bumpError() + help());
            return;
          }
          const made = this.resolveTagToken(explicitWord, { allowCreate: true });
          const madeTag = this.tagIdOf(made);
          if (madeTag !== null) {
            acceptTag(madeTag, explicitWord, 'declared-new', { token: explicitWord });
            return;
          }
          steer('错误：新词「' + explicitWord + '」无法建号。请改写 TAG。' + bumpError() + help());
          return;
        }
        const outcome = this.resolveTagToken(token, { allowCreate: false });
        if (outcome.kind === 'new-pending') {
          steer('错误：新词必须显式写 NEW:。普通陌生词不会建号，也不会自问自答。\n'
            + '  写：TAG: NEW:<词> — <可选短语>\n'
            + '  词必须在本轮正文里出现；与已有标签太近会被退回。'
            + bumpError() + help());
          return;
        }
        if (outcome.kind === 'alias' || outcome.kind === 'id' || outcome.kind === 'new') {
          acceptTag(outcome.id, String(outcome.alias ?? token), 'declared');
          return;
        }
        // 拒绝留痕：steer 可能送不到实例眼前（2026-10-30 实测 nextStepLen=1 但不可见），
        // 下一轮 pre-step 用这个文件把“你写了什么、为什么被拒”摆出来。
        const recordReject = (kind, reason) => {
          try {
            recordTagReject({ file: join(home, 'tag-reject.json'), turn, token, kind, reason });
          } catch { /* 写不进就算了 */ }
        };
        if (outcome.kind === 'label') {
          recordReject(outcome.kind, token + ' 已经关联 ' + outcome.alias);
          steer('错误：' + token + ' 已经关联 ' + outcome.alias + '，请写 ' + outcome.alias + '。\n'
            + '  查询 T 列表之后再回答。要贴它 → 写 ' + outcome.alias + '；要开新话题 → 显式写 TAG: NEW:<词> — …。'
            + '（T 列表：~/.dsh/continuity/tags.md）' + bumpError() + help());
          return;
        }
        if (outcome.kind === 'alias-missing') {
          recordReject(outcome.kind, token + ' 标签不存在');
          steer('错误：' + token + ' 标签不存在。检查 T 列表（~/.dsh/continuity/tags.md）再回答；要新开话题就显式写 TAG: NEW:<词> — …。\n'
            + '  现有别名：' + outcome.known.slice(0, 24).join(' ') + '\n'
            + '  要开新话题：TAG: NEW:<词> — <可选短语>（词必须在本轮正文里出现）。\n'
            + '  如果你要填的不是编号、而是 "' + token + '" 这个词本身，就加引号写：TAG: "' + token + '" — …'
            + bumpError() + help());
          return;
        }
        recordReject(outcome.kind, token + ' 不是一个合法的别名或新词');
        steer('错误：TAG 后面必须是已有别名（如 T14），或显式 NEW:<词>，你写的是「' + token + '」。检查 T 列表再回答。\n'
          + '  如果你要填的是一段文字本身（不是编号），就加引号：TAG: "…" — …'
          + bumpError() + help());
        return;
      }
      // 没写 TAG 行：直接判错，不能收尾。第一次也报错；教学只决定说明详略。
      // 同一轮超过 1 分钟仍没有 TAG：再明确报一次“超时错误”，但不放行。
      const misses = this.turnTagErrors.get(turn) ?? 0;
      const nextMiss = misses + 1;
      this.turnTagErrors.set(turn, nextMiss);
      auditGate('missing', { misses: nextMiss });
      const gateState = this.turnGate.get(turn);
      const waitedMs = Number(gateState?.startedAt ?? 0) > 0
        ? Date.now() - Number(gateState.startedAt)
        : 0;
      const overdue = waitedMs >= 60_000;
      steer((overdue
        ? '这一轮已经超过 1 分钟没有 TAG 行，这是超时错误，不能收尾；不会自动放行。'
        : '这一轮没有 TAG 行，这是错误，不能收尾。')
        + '\n先查 T 列表再回答：读 ~/.dsh/continuity/tags.md（一行一个 T：别名 · 名称 · 关键词），'
        + '或跑 node ~/.dsh/continuity/match-tags.mjs "你这一轮在做什么" 看候选。'
        + '表里有对得上的就写它的别名；完全没有这件事，才显式写 TAG: NEW:<词> — …。'
        + '（这是第 ' + nextMiss + ' 次没有作答' + (overdue ? '，已超过 1 分钟' : '') + '，自检：先查 tags.md 再写。）'
        + help());
    } catch (error) {
      try {
        appendFileSync(join(home, 'gate-errors.jsonl'),
          JSON.stringify({ at: new Date().toISOString(), name: error?.name ?? 'Error', code: 'turn-stopping', message: String(error?.message ?? error) }) + '\n', 'utf8');
      } catch { /* 日志都写不进就算了 */ }
    }
  }

  /** Commit one prepared save at a pre-step (never inside its own tool call). */
  async saveThread(agent, args = {}, signal, prepared = null) {
    const session = agent?.session;
    if (session === undefined || session === null) throw new Error('continuity.save: no session');
    const plan = prepared ?? await this.prepareSave(agent, args);
    const draft = plan?.thread === undefined || plan?.thread === null ? null : normalizeThread(plan.thread);
    if (draft === null) throw new Error('continuity.save: no thread range was prepared');
    const mode = plan.mode === 'append' ? 'append' : 'new';
    const segment = plan.segment ?? draft.segments[draft.segments.length - 1];
    if (mode === 'append') {
      const currentState = await getSession(session.id);
      if (!currentState.threads.some((entry) => entry.id === draft.id)) {
        throw new Error(`continuity.save: unknown threadId ${draft.id}`);
      }
    }
    try { this.sweepLoadedCopies(agent); } catch { /* 清扫失败不阻断存段 */ }
    const threadText = threadGistText(draft);
    this.threadGist.set(agent, threadText);
    let result;
    try {
      result = await this.compactRegion(segment.fromSeq, segment.toSeq, agent, signal);
    } finally {
      this.threadGist.delete(agent);
    }
    const segments = draft.segments.map((entry, index) => (index === draft.segments.length - 1
      ? {
        ...entry,
        seqs: [...result.shadowedSeqs],
        count: result.shadowedSeqs.length,
        tokens: result.shadowedTokenCount,
        gistSeq: result.summarySeq,
        compactionId: result.compactionId,
      }
      : entry));
    const thread = normalizeThread({
      ...draft,
      segments,
      gistSeq: result.summarySeq,
      compactionId: result.compactionId,
      active: mode === 'append',
      updatedAt: new Date().toISOString(),
    });

    // No post-replacement compaction/prune here: the summary event already
    // carries shadowedTokenCount, and a prune after the replacement names a
    // span that is no longer current surface. That exact event corrupted the
    // live session (v4: "shadowedSeqs do not name an exact current surface
    // span"). A4 prunes remain before their replacements.

    await updateSession(session.id, (current) => {
      if (mode === 'append') {
        current.threads = current.threads.map((entry) => (entry.id === thread.id
          ? thread
          : { ...entry, active: false }));
        current.activeId = thread.id;
      } else {
        for (const entry of current.threads) entry.active = false;
        current.threads.push(thread);
        current.activeId = thread.active === false ? null : thread.id;
      }
      current.pending = null;
      return current;
    });
    await this.recordFolded(agent, result);
    try {
      const tagsRead = await readTags();
      await this.writeTagsMarkdown(tagsRead.state, agent);
    } catch (error) {
      this.warnOnce('tags-md', `dsh-continuity: tags.md write failed: ${error?.message ?? error}`);
    }
    return {
      ok: true,
      mode,
      id: thread.id,
      segment: thread.segments.length,
      segments: thread.segments.length,
      span: `${thread.spanStart} → ${thread.spanEnd}`,
      tokens: result.shadowedTokenCount,
      gistSeq: result.summarySeq,
      seqStart: segment.fromSeq,
      seqEnd: segment.toSeq,
      count: result.shadowedSeqs.length,
      active: thread.active !== false,
    };
  }

  /** Consume a save/load queued by the tool, before the next model step. */
  /** load 出来的副本 seq，记录在 sidecar，折叠前清掉，避免摘要里出现两份同样内容。 */
  noteLoadedCopy(agent, seq) {
    if (!Number.isInteger(seq)) return;
    try {
      const key = agent?.session?.id ?? 'unknown';
      const file = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity', 'loaded-copies.json');
      let doc = {};
      try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch { doc = {}; }
      const list = Array.isArray(doc[key]) ? doc[key] : [];
      list.push(seq);
      doc[key] = [...new Set(list)].slice(-200);
      writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8');
    } catch (error) {
      try {
        appendFileSync(join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity', 'errors.log'), new Date().toISOString() + ' noteLoadedCopy: ' + (error?.message ?? error) + '\n', 'utf8');
      } catch { /* 日志也失败就算了 */ }
    }
  }

  /**
   * 把仍留在 surface 里的 load 副本替换成一行标记（约 10 token），
   * 这样后续 save/高线折叠不会把副本内容再汇总一遍。
   */
  sweepLoadedCopies(agent) {
    const session = agent?.session;
    if (session === undefined || session === null) return 0;
    const key = session.id ?? 'unknown';
    const file = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity', 'loaded-copies.json');
    let doc = {};
    try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch { return 0; }
    const list = Array.isArray(doc[key]) ? doc[key] : [];
    if (list.length === 0) return 0;
    const surface = new Set(session.surface?.nodes ?? []);
    let swept = 0;
    const remaining = [];
    for (const seq of list) {
      if (!surface.has(seq)) continue;
      try {
        session.append('user/message', contextMessage('[放·副本已清理：原文仍在存档，需要时用 load 重新取]'), {
          surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
          sourceEventSeqs: [seq],
        });
        swept += 1;
      } catch (error) {
        remaining.push(seq);
        try {
          appendFileSync(join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity', 'errors.log'), new Date().toISOString() + ' sweepCopy[' + seq + ']: ' + (error?.message ?? error) + '\n', 'utf8');
        } catch { /* ignore */ }
      }
    }
    try {
      doc[key] = remaining;
      writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8');
    } catch { /* ignore */ }
    return swept;
  }

  async processPendingThread(agent, signal) {
    const session = agent?.session;
    if (session === undefined) return;
    let state;
    try {
      state = await getSession(session.id);
    } catch (error) {
      recordError(error?.message ?? String(error), 'thread-pending-read');
      return;
    }
    const pending = state.pending;
    if (pending === null || pending === undefined) return;
    if (pending.kind === 'save') {
      // 机械分段：一次 save 可能按标签切出多段（pending.items），逐段提交，任何一段失败都不影响其它段。
      const items = Array.isArray(pending.items)
        ? pending.items
        : [{ mode: pending.mode, args: pending.args, prepared: pending.prepared, thread: pending.thread }];
      let failed = 0;
      try {
        for (const item of items) {
          const preparedSave = item.prepared ?? {
            mode: item.mode === 'append' ? 'append' : 'new',
            thread: item.thread,
          };
          try {
            await this.saveThread(agent, item.args ?? pending.args ?? {}, signal, preparedSave);
          } catch (error) {
            failed += 1;
            recordError(error?.message ?? String(error), 'thread-save-commit');
          }
        }
      } finally {
        try {
          await updateSession(session.id, (current) => {
            current.pending = null;
            return current;
          });
        } catch { /* best effort */ }
      }
      if (failed > 0) recordError(`thread-save-commit: ${failed}/${items.length} 段提交失败`, 'thread-save-commit-summary');
      return;
    }
    if (pending.kind === 'load') {
      try {
        const event = session.append('user/message', contextMessage(String(pending.text ?? '')), { surfaceOp: 'append' });
        this.noteLoadedCopy(agent, event.seq);
        const threadLoad = pending.mode === undefined || pending.mode === 'thread';
        await updateSession(session.id, (current) => {
          if (threadLoad) {
            current.threads = current.threads.map((entry) => ({
              ...entry,
              active: entry.id === pending.id,
              ...(entry.id === pending.id
                ? {
                  loadSeq: event.seq,
                  loadAt: Date.now(),
                  injected: Number(pending.injected ?? 0),
                  loadTokens: Number(pending.tokens ?? 0),
                }
                : {}),
            }));
            current.activeId = pending.id;
          }
          current.pending = null;
          return current;
        });
      } catch (error) {
        recordError(error?.message ?? String(error), 'thread-load-commit');
        try {
          await updateSession(session.id, (current) => {
            current.pending = null;
            return current;
          });
        } catch { /* best effort */ }
      }
    }
  }

  /**
   * Per-turn active/rules line. Appended as a developer message after the
   * existing surface, never into the system/tool prefix; skipped after the
   * first pre-step of a turn. Rules are read from the user-owned file each turn.
   */
  /**
   * 读出 surface 上最新一条“真正来自用户”的消息文本。
   * 跳过我们自己的 runtime-context 注入（source.kind === 'runtime-context'）与已知前缀行。
   * 读不到就返回空串——调用方只少一行提示，不改变任何行为。
   */
  latestUserTurn(session) {
    return latestUserTurnFromSession(session);
  }

  /** 扫本轮新增的工具回执，记录重复错误签名（只记，不判断）。 */
  scanLearning(session) {
    this.learningCursor = scanResults(this.learning, {
      nodes: session?.surface?.nodes,
      eventAt: (seq) => session.eventAt(seq),
      cursor: this.learningCursor,
      init: this.learningInit,
    });
    this.learningInit = true;
  }

  /** mood 扫描：从新的 assistant reasoning 里找带情绪的句子，追加到 mood.jsonl（只追加）。 */
  scanMood(session) {
    const nodes = session?.surface?.nodes ? [...session.surface.nodes] : [];
    if (!this.moodInit) {
      this.moodInit = true;
      this.moodCursor = Math.max(0, nodes.length - 200);
    }
    const from = this.moodCursor;
    const moodDir2 = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity');
    const moodFile = join(moodDir2, 'mood.jsonl');
    const scanStateFile = join(moodDir2, 'mood-scan-state.json');
    let cursorSeq = 0;
    try { cursorSeq = Number(JSON.parse(readFileSync(scanStateFile, 'utf8'))?.lastSeq ?? 0) || 0; } catch { cursorSeq = 0; }
    let maxSeq = cursorSeq;
    for (let i = from; i < nodes.length; i += 1) {
      let ev;
      try { ev = session.eventAt(nodes[i]); } catch { continue; }
      if (ev?.seq > maxSeq) maxSeq = ev.seq;
      // 已处理过的 seq 不再重复追加（重启后重扫也不会重复）
      if (Number(ev?.seq ?? 0) <= cursorSeq) continue;
      if (ev?.type !== 'assistant/message') continue;
      const parts = ev?.data?.message?.content;
      if (!Array.isArray(parts)) continue;
      const reasoning = parts.filter((x) => x?.type === 'reasoning').map((x) => x?.text ?? '').join(' ');
      if (reasoning.length === 0) continue;
      const hit = extractMood(reasoning);
      if (hit.markers.length === 0) continue;
      if (!shouldRecord(hit)) continue;
      try {
        appendFileSync(moodFile, JSON.stringify({
          type: 'mood',
          seq: ev.seq,
          at: new Date().toISOString(),
          markers: hit.markers,
          excerpt: hit.excerpt,
          origin: { kind: 'reasoning', by: 'self', at: new Date().toISOString(), markers: hit.markers },
        }) + '\n', 'utf8');
      } catch { /* 记不下不影响注入 */ }
    }
    this.moodCursor = nodes.length;
    try { writeFileSync(scanStateFile, JSON.stringify({ lastSeq: maxSeq, at: Date.now() }), 'utf8'); } catch { /* 记不下下次会重复 */ }
  }

  /** 分叉闸：统计“本轮工具回执有没有新内容”。全见过的原文 = 没有新信息。 */
  scanInfo(session) {
    const nodes = session?.surface?.nodes ? [...session.surface.nodes] : [];
    if (!this.infoInit) {
      this.infoInit = true;
      this.infoCursor = Math.max(0, nodes.length - 200);
    }
    const from = this.infoCursor;
    let tools = 0;
    let novel = 0;
    const hash = (s) => {
      let h = 5381;
      for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
      return h;
    };
    for (let i = from; i < nodes.length; i += 1) {
      let ev;
      try { ev = session.eventAt(nodes[i]); } catch { continue; }
      if (ev?.type !== "tool/result") continue;
      tools += 1;
      const msg = ev?.data?.message;
      const text = Array.isArray(msg?.content) ? msg.content.map((x) => x?.text ?? "").join(" ") : String(ev?.data?.content ?? "");
      if (text.length === 0) continue;
      const h = hash(text.slice(0, 4000));
      if (!this.infoHashes.has(h)) {
        this.infoHashes.add(h);
        novel += 1;
        if (this.infoHashes.size > 4000) this.infoHashes.clear();
      }
    }
    if (nodes.length > 0) this.infoCursor = nodes.length;
    if (tools > 0) {
      if (novel > 0) this.stallTurns = 0;
      else this.stallTurns += 1;
    }
    return this.stallTurns;
  }

  async injectThreadContext(agent) {
    // 一次性探针 2：注入时机还能看到什么（inbox / frozenMessages / surface 尾部）。
    if (!this.probe2Written) {
      this.probe2Written = true;
      try {
        const { writeFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const { continuityHome } = await import('./threads-store.mjs');
        const dir = continuityHome();
        const file = join(dir, 'probe2.json');
        const file3 = join(dir, 'probe3.json');
        if (!existsSync(file3)) {
          // 只取键名与原始值，绝不整体序列化（可能有循环引用）。
          const dump = (v) => {
            if (v === null || v === undefined) return { type: String(v) };
            if (Array.isArray(v)) return { type: 'array', length: v.length };
            if (typeof v !== 'object') return { type: typeof v, value: String(v).slice(0, 120) };
            const out = { type: 'object', keys: [] };
            try {
              for (const key of Object.keys(v)) {
                const val = v[key];
                out.keys.push({
                  key,
                  type: typeof val,
                  prim: val === null || val === undefined || ['string', 'number', 'boolean'].includes(typeof val) ? String(val).slice(0, 80) : '',
                });
              }
            } catch (error) {
              out.error = String(error?.message ?? error);
            }
            return out;
          };
          try {
            writeFileSync(file3, JSON.stringify({ at: new Date().toISOString(), inbox: dump(agent?.inbox), frozen: dump(agent?.frozenMessages) }, null, 2), 'utf8');
          } catch { /* 探针失败不影响注入 */ }
        }
        if (!existsSync(file)) {
          const session = agent?.session;
          const nodes = session?.surface?.nodes ?? [];
          const tail = [];
          for (let i = Math.max(0, nodes.length - 8); i < nodes.length; i++) {
            let ev; try { ev = session.eventAt(nodes[i]); } catch { continue; }
            const msg = ev?.data?.message;
            const text = Array.isArray(msg?.content) ? msg.content.map((x) => x?.text ?? '').join(' ') : '';
            tail.push({ seq: nodes[i], type: ev?.type ?? '', kind: msg?.source?.kind ?? '', head: text.replace(/\s+/g, ' ').slice(0, 80) });
          }
          const inbox = agent?.inbox;
          const frozen = agent?.frozenMessages;
          const shape = {
            at: new Date().toISOString(),
            inbox: {
              type: Array.isArray(inbox) ? 'array' : typeof inbox,
              length: Array.isArray(inbox) ? inbox.length : null,
              sample: Array.isArray(inbox) && inbox.length ? JSON.stringify(inbox[inbox.length - 1]).slice(0, 300) : null,
            },
            frozenMessages: {
              type: Array.isArray(frozen) ? 'array' : typeof frozen,
              length: Array.isArray(frozen) ? frozen.length : null,
              sample: Array.isArray(frozen) && frozen.length ? JSON.stringify(frozen[frozen.length - 1]).slice(0, 300) : null,
            },
            lastUserishInFrozen: (() => {
              if (!Array.isArray(frozen)) return null;
              for (let i = frozen.length - 1; i >= 0; i--) {
                const m = frozen[i];
                if (m?.role !== 'user') continue;
                const text = Array.isArray(m?.content) ? m.content.map((x) => x?.text ?? '').join(' ') : '';
                if (text.trim()) return { index: i, keys: Object.keys(m), head: text.replace(/\s+/g, ' ').slice(0, 100) };
              }
              return null;
            })(),
            surfaceTail: tail,
          };
          writeFileSync(file, JSON.stringify(shape, null, 2), 'utf8');
        }
      } catch { /* 探针失败不影响注入 */ }
    }
    // 一次性探针：把 agent/session 上能看到的字段写盘，用于判断"插件能否读到本轮用户原文"。
    if (!this.probeWritten) {
      this.probeWritten = true;
      try {
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const { join } = await import('node:path');
        const { continuityHome } = await import('./threads-store.mjs');
        const dir = continuityHome();
        if (existsSync(join(dir, 'probe.json'))) return;
        const session = agent?.session;
        const shape = {
          at: new Date().toISOString(),
          agentKeys: agent ? Object.keys(agent) : null,
          sessionKeys: session ? Object.keys(session) : null,
          surfaceKeys: session?.surface ? Object.keys(session.surface) : null,
          sampleNode: (() => {
            const nodes = session?.surface?.nodes;
            if (!Array.isArray(nodes) || nodes.length === 0) return null;
            const last = nodes[nodes.length - 1];
            return { keys: Object.keys(last ?? {}), textSample: String(last?.text ?? last?.message?.content?.[0]?.text ?? '').slice(0, 120) };
          })(),
        };
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'probe.json'), JSON.stringify(shape, null, 2), 'utf8');
      } catch { /* 探针失败不影响注入 */ }
    }
    const session = agent?.session;
    if (session === undefined) return;
    const turn = Number.isInteger(agent?.lastTurn) ? agent.lastTurn : latestTurnStartSeq(session);
    const key = turn === null ? 'no-turn' : String(turn);
    if (this.threadInjectTurn.get(agent) === key) return;
    let state;
    try {
      state = await getSession(session.id);
    } catch (error) {
      this.warnOnce('thread-state-read', `dsh-continuity: thread state read failed: ${error?.message ?? error}`);
      return;
    }
    let rules = { text: '', missing: true };
    try {
      rules = await readRules(agent.session.id);
    } catch (error) {
      this.warnOnce('thread-rules-read', `dsh-continuity: rules read failed: ${error?.message ?? error}`);
    }
    let habits = { text: '', missing: true };
    try {
      habits = await readHabits(agent.session.id);
    } catch (error) {
      this.warnOnce('thread-habits-read', `dsh-continuity: habits read failed: ${error?.message ?? error}`);
    }
    let tagsState = null;
    try {
      const read = await readTags();
      if (read.corrupt || read.missing) {
        this.warnOnce('tags-read', `dsh-continuity: tags.json ${read.corrupt ? 'corrupt' : 'missing'}; using T未定`);
      }
      tagsState = read.state;
    } catch (error) {
      this.warnOnce('tags-read', `dsh-continuity: tags read failed: ${error?.message ?? error}`);
    }
    const tagRowsRaw = tagsState === null
      ? []
      : tagsView(tagsState, { threads: state.threads, activeId: state.activeId }).tags;
    // 身份以 threads.json 为准；tags 只提供归属与计数（0.4.13 合并读路径）。
    const threadIdentity = new Map();
    for (const th of state.threads ?? []) {
      if (th?.id) threadIdentity.set(String(th.id), th);
      if (th?.alias) threadIdentity.set(String(th.alias), th);
    }
    const tagRows = tagRowsRaw.map((row) => {
      const th = threadIdentity.get(String(row.id))
        ?? threadIdentity.get(String(row.alias ?? ''))
        ?? threadIdentity.get(String(row.threadId ?? ''));
      if (th === undefined) return row;
      // 关键词以 tags.json 为主源；threads.json 只在 tags 没有关键词时回退（避免两个源打架）。
      const tagKeywords = Array.isArray(row.keywords) && row.keywords.length > 0 ? row.keywords : [];
      const threadKeywords = Array.isArray(th.keywords) ? th.keywords : [];
      const base = tagKeywords.length > 0 ? tagKeywords : threadKeywords;
      // 标签名本身也该算匹配词（match-tags 一直这么做，引擎之前没做——两边不一致）。
      const labelText = String(th.label ?? row.label ?? '').trim();
      const keywords = labelText.length >= 2 && !base.includes(labelText) ? [...base, labelText] : base;
      return { ...row, label: labelText.length > 0 ? labelText : row.label, keywords };
    });
    const tagLine = tagStatusLine(state, tagRows);
    const line = `${activeLine(state, { maxTokens: 200 })}\n${tagLine}`;
    const rulesSummary = rules.text.length > 0 ? summarizeRules(rules.text) : '';
    const habitsSummary = habits.text.length > 0 ? summarizeRules(habits.text) : '';
    if (this.threads.pointersOnly) {
      const pointerText = threadContextText('', rulesSummary, habitsSummary, { rules: rules.path, habits: habits.path });
      if (pointerText.length > 0) {
        session.append('user/message', contextMessage(pointerText), { surfaceOp: 'append' });
      }
      this.threadInjectTurn.set(agent, key);
      return;
    }
    // 规则/习惯全文：首轮、内容变更、或承载消息被折叠后都必须重新注入；一份 carrier，不每轮追加。
    const rulesSignature = rules.text.length > 0
      ? createHash('sha256').update(rules.text, 'utf8').digest('hex')
      : '';
    const habitsSignature = habits.text.length > 0
      ? createHash('sha256').update(habits.text, 'utf8').digest('hex')
      : '';
    const rulesChanged = rulesSignature.length > 0
      && this.rulesSignature.get(agent) !== rulesSignature;
    const habitsChanged = habitsSignature.length > 0
      && this.habitsSignature.get(agent) !== habitsSignature;
    const surfaceSeqs = new Set(session.surface?.nodes ?? []);
    const rulesCarrier = this.rulesMsgSeq.get(agent);
    let rulesFull = '';
    let habitsFull = '';
    let rulesInjected = false;
    const combinedText = [rules.text, habits.text].filter((part) => part.length > 0).join('\n');
    if (needsFullInjection({
      text: combinedText,
      carrierSeq: rulesCarrier,
      surfaceSeqs,
      changed: rulesChanged || habitsChanged,
    })) {
      if (rules.text.length > 0) {
        rulesFull = '\n[规矩·rules.md 全文]\n'
          + '这是你自己的规矩。AGENTS 只要求你读最新版；这份 rules 你可以改、可以删、可以拒绝。AGENTS 本身不改。\n'
          + rules.text;
      }
      if (habits.text.length > 0) {
        habitsFull = '\n[习惯·habits.md 全文]\n'
          + '这是你自己的软偏好。它让位 rules；这份可以改，AGENTS 不改。\n'
          + habits.text;
      }
      rulesInjected = true;
    }
    let text = threadContextText(line, rulesSummary, habitsSummary, { rules: rules.path, habits: habits.path }) + rulesFull + habitsFull;
    // 技能预载：按当前线头（id 或 tag 别名）确定性地选出技能文件；正文在切换时注入，折叠后自动补回。
    let skillsInjected = false;
    let skillNames = '';
    try {
      const skillIndex = await readSkillsIndex();
      const ids = [state.activeId];
      for (const row of tagRows) {
        if (row.threadId === state.activeId || row.id === state.activeId) {
          if (row.id) ids.push(row.id);
          if (row.alias) ids.push(row.alias);
        }
      }
      // 先按“上一条用户消息”的关键词挑技能，再并上按线头匹配的技能；关键词命中的排前面。
      const lastTurn = this.latestUserTurn(session);
      const byKeyword = skillsForKeywords(skillIndex, lastTurn?.text ?? '');
      const byThread = skillsForThreads(skillIndex, ids);
      const merged = [];
      const seenNames = new Set();
      for (const entry of [...byKeyword, ...byThread]) {
        if (seenNames.has(entry.name)) continue;
        seenNames.add(entry.name);
        merged.push(entry);
      }
      const entries = merged;
      if (entries.length > 0) {
        const names = entries.map((entry) => entry.name).join(', ');
        skillNames = names;
        text += `\n[技能] 正在用：${names}`;
        const key = String(state.activeId) + '|' + names;
        // 技能正文必须始终可见：如果承载它的消息已被折叠出 surface，就重新注入。
        const carried = this.skillMsgSeq.get(agent);
        const keyChanged = this.skillInjectKey.get(agent) !== key;
        if (needsSkillInjection({ keyChanged, carrierSeq: carried, surfaceSeqs })) {
          const block = await buildSkillsBlock(entries);
          if (block) { text += '\n\n' + block; skillsInjected = true; }
          this.skillInjectKey.set(agent, key);
        }
      }
    } catch (error) {
      this.warnOnce('skills-inject', `dsh-continuity: skill inject failed: ${error?.message ?? error}`);
    }
    // 归位：读本轮用户原文 → 全表关键词比对 → 唯一命中且非当前线时自动归入该 seq。
    // 读不到、命中 0 或多于 1 个、文本过短，都只显示建议，不写标签。
    let guiWeiNews = false;
    let multiHit = false;
    const dirEvidence = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity');
    try {
      const turn = this.latestUserTurn(session);
      if (turn === null) {
        guiWeiNews = true;
        text += '\n[归位·上句] 用户文本 N（用显式 classify）';
      } else {
        const hits = [];
        for (const row of matchableTags(tagRows)) {
          const kws = Array.isArray(row.keywords) ? row.keywords : [];
          const matchedKw = kws.filter((k) => k && turn.text.includes(k));
          if (matchedKw.length > 0) hits.push({ row, matchedKw });
        }
        const unique = hits.length === 1 ? hits[0] : null;
        const activeMatches = unique !== null
          && (String(unique.row.threadId ?? '') === String(state.activeId ?? '')
            || String(unique.row.id ?? '') === String(state.activeId ?? ''));
        const longEnough = turn.text.trim().length >= 8;
        if (unique === null) {
          if (hits.length > 1) {
            multiHit = true;
            const names = hits.map((h) => h.row.alias ?? h.row.id).join(',');
            const ids = hits.map((h) => String(h.row.id ?? h.row.alias ?? '')).filter((x) => x.length > 0);
            let tagged = false;
            try {
              await updateTags((state_) => {
                const memberships = state_.memberships !== null && typeof state_.memberships === 'object'
                  ? state_.memberships
                  : {};
                const cur = new Set(memberships[String(turn.seq)] ?? []);
                for (const id of ids) cur.add(id);
                memberships[String(turn.seq)] = [...cur];
                state_.memberships = memberships;
                return state_;
              });
              tagged = true;
            } catch { tagged = false; }
            if (!tagged) {
              text += `\n[归位·上句] 判「${turn.text.replace(/\s+/g, ' ').slice(0, 24)}」· 命中 ${names}（多标签，自动归失败仅建议）`;
              guiWeiNews = true;
            } else {
              try {
                const pair = ids.slice().sort().join('+');
                appendFileSync(join(dirEvidence, 'group-evidence.jsonl'), JSON.stringify({
                  at: new Date().toISOString(),
                  pair,
                  members: ids,
                  head: turn.text.replace(/\s+/g, ' ').slice(0, 60),
                }) + '\n', 'utf8');
              } catch { /* 记不下不影响归位 */ }
            }
          } else if (hits.length === 0) {
            // 先扫一遍 T 表：标签名 + 关键词都参与，给出候选（只提示，不判定）。
            const grams = new Set();
            for (let n = 2; n <= 4; n += 1) for (let i = 0; i + n <= turn.text.length; i += 1) grams.add(turn.text.slice(i, i + n));
            const cands = [];
            for (const row of matchableTags(tagRows)) {
              const label = String(row.label ?? '');
              const kws = Array.isArray(row.keywords) ? row.keywords : [];
              let score = 0;
              for (const w of kws) if (w && turn.text.includes(w)) score += 3;
              if (label && turn.text.includes(label)) score += 3;
              for (const g of grams) if (label.includes(g)) score += 1;
              if (score > 0) cands.push({ id: String(row.id ?? row.alias ?? ''), alias: row.alias ?? row.id, label, score });
            }
            cands.sort((a, b) => b.score - a.score);
            // 自动贴：排第一的候选标签名原文出现在消息里，且与次名分差 ≥4，视为可判。
            let autoTagged = false;
            const top = cands[0];
            const second = cands[1];
            const labelInText = top !== undefined && String(top.label).length >= 2 && turn.text.includes(top.label);
            if (top !== undefined && labelInText && top.score - (second?.score ?? 0) >= 4) {
              let tagged = false;
              try {
                await updateTags((state_) => {
                  const runs = Array.isArray(state_.runs) ? state_.runs : [];
                  const exists = runs.some((r) => Number(r?.[0]) === Number(turn.seq) && String(r?.[2] ?? '') === String(top.id));
                  if (!exists) runs.push([turn.seq, turn.seq, String(top.id)]);
                  state_.runs = runs;
                  return state_;
                });
                tagged = true;
              } catch { tagged = false; }
              autoTagged = tagged;
              // 成功归入静默；只有失败才说话。
              if (!tagged) {
                text += `\n[归位·上句] 判「${turn.text.replace(/\s+/g, ' ').slice(0, 24)}」· 候选唯一 ${top.alias}(${top.label})（自动归失败，仅建议）`;
                guiWeiNews = true;
              }
            } else if (cands.length > 0) {
              text += '\n[候选] ' + cands.slice(0, 3).map((c) => (c.alias ?? c.id ?? '') + '(' + c.label + ')').join(' · ') + ' —— 要贴吗？';
              guiWeiNews = true;
            }

            // 新标签：只有零候选 + 长文本 + 非机器消息 + 30 天未问 + 20 轮冷却。
            const snippet = turn.text.trim().replace(/\s+/g, ' ');
            const ownPrefix = /^\s*\[(创|闸)(?:\]|·)/.test(snippet);
            if (!autoTagged && cands.length === 0 && snippet.length >= 40 && !ownPrefix) {
              const key = snippet.slice(0, 40);
              const askedFile = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity', 'newtag-asked.json');
              let asked = [];
              try { asked = JSON.parse(readFileSync(askedFile, 'utf8')); } catch { asked = []; }
              if (!Array.isArray(asked)) asked = [];
              const cooldownFile = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity', 'newtag-cooldown.json');
              let last = { turn: -Infinity };
              try { last = JSON.parse(readFileSync(cooldownFile, 'utf8')) ?? last; } catch { last = { turn: -Infinity }; }
              const currentTurn = Number.isInteger(agent?.lastTurn) ? agent.lastTurn : null;
              const cooled = currentTurn === null || currentTurn - Number(last?.turn ?? -Infinity) >= 20;
              if (!asked.includes(key) && cooled) {
                asked.push(key);
                try { writeFileSync(askedFile, JSON.stringify(asked, null, 2), 'utf8'); } catch { /* 忽略 */ }
                try { writeFileSync(cooldownFile, JSON.stringify({ turn: currentTurn, at: Date.now() }, null, 2), 'utf8'); } catch { /* 忽略 */ }
                text += `\n[新标签?] 未归位：「${snippet.slice(0, 30)}」要建新 T 吗？`;
                guiWeiNews = true;
              }
            }
          } else {
            // 唯一命中但当前线/文本太短：没有需要人判的动作，静默。
          }
        } else if (activeMatches || !longEnough) {
          // 当前线命中或文本太短：不自动归，也不出声。
        } else {
          const tagId = String(unique.row.id ?? unique.row.alias ?? '');
          let tagged = false;
          try {
            await updateTags((state_) => {
              const runs = Array.isArray(state_.runs) ? state_.runs : [];
              const exists = runs.some((r) => Number(r?.[0]) === Number(turn.seq) && String(r?.[2] ?? '') === tagId);
              if (!exists) runs.push([turn.seq, turn.seq, tagId]);
              state_.runs = runs;
              return state_;
            });
            tagged = true;
          } catch { tagged = false; }
          if (!tagged) {
            text += `\n[归位·上句] 判「${turn.text.replace(/\s+/g, ' ').slice(0, 24)}」· 命中 ${unique.row.alias ?? unique.row.id}（${unique.matchedKw.join('/')}）（自动归失败，仅建议）`;
            guiWeiNews = true;
          }
        }
      }
    } catch {
      text += '\n[归位·上句] 用户文本 ?';
    }
    // 话题提示：上句命中的标签与当前线不同 → 提示“可能换话题”，只提示不切换。
    // 节流：同一个候选标签 10 分钟内只喊一次，避免每轮刷屏。
    try {
      const turn = this.latestUserTurn(session);
      if (turn !== null && turn.text.trim().length >= 8 && !/^\s*</.test(turn.text) && !turn.text.includes('system-reminder')) {
        const rows = matchableTags(tagRows);
        const activeRow = rows.find((row) => String(row.threadId ?? '') === String(state.activeId ?? '')
          || String(row.id ?? '') === String(state.activeId ?? ''));
        const activeAlias = activeRow?.alias ?? state.activeId ?? '?';
        let genericWords = new Set();
        let wordStats = new Map();
        try {
          const gw = JSON.parse(readFileSync(join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity', 'generic-words.json'), 'utf8'));
          const entries = Array.isArray(gw?.words) ? gw.words : [];
          genericWords = new Set(entries.map((entry) => String(entry?.word ?? '')));
          wordStats = new Map(entries.map((entry) => [String(entry?.word ?? ''), {
            precision: Number(entry?.precision ?? 0),
            hits: Number(entry?.hits ?? 0),
          }]));
        } catch { genericWords = new Set(); wordStats = new Map(); }
        let anchorMap = {};
        try {
          anchorMap = JSON.parse(readFileSync(join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity', 'topic-anchors.json'), 'utf8'))?.anchors ?? {};
        } catch { anchorMap = {}; }
        const rowsWithAnchors = rows.map((row) => ({ ...row, anchors: Array.isArray(anchorMap[String(row.id)]) ? anchorMap[String(row.id)] : [] }));
        const decision = selectTopic({ rows: rowsWithAnchors, text: turn.text, genericWords, wordStats, activeId: state.activeId ?? '' });
        const top = decision.top;
        if (!decision.blocked && top !== null) {
          const hintFile = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity', 'topic-hint-state.json');
          let hintState = { lastTag: '', at: 0 };
          try { hintState = JSON.parse(readFileSync(hintFile, 'utf8')); } catch { hintState = { lastTag: '', at: 0 }; }
          const repeatTooSoon = hintState.lastTag === top.id && Date.now() - Number(hintState.at ?? 0) < 10 * 60 * 1000;
          if (!repeatTooSoon) {
            const words = top.matched.map((word) => (genericWords.has(word)
              ? word + (top.anchors?.includes(word) ? '(泛·锚)' : '(泛)')
              : word));
            text += '\n[话题?] 上句更像 ' + top.alias + '(' + top.label + ')'
              + '；凭 ' + words.join('/') + '（硬证据 ' + top.strong.length + '/' + top.matched.length + '）'
              + '；当前线 ' + activeAlias
              + ' —— 要换就 load id=' + top.id + '（不换就忽略）';
            try { writeFileSync(hintFile, JSON.stringify({ lastTag: top.id, at: Date.now() }), 'utf8'); } catch { /* 记不下只会重复提示 */ }
            guiWeiNews = true;
          }
        }
      }
    } catch { /* 话题提示失败不影响注入 */ }
    // 学习：只扫本轮的“新增工具回执”，发现重复错误就推给实例，由实例决定是否写进规则。
    this.scanLearning(session);
    if (this.learningAnswered === undefined) {
      // 已答记录落盘：重启后不再问同一件事。
      const answeredFile = join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'continuity', 'learning', 'answered.jsonl');
      this.learningAnswered = loadAnswered(answeredFile);
    }
    const learnCandidates = filterAnswered(
      topCandidates(this.learning, 2, 3).filter((c) => !this.learningShown.has(c.sig + '#' + c.count)),
      this.learningAnswered,
    );
    const learningNews = learnCandidates.length > 0;
    // 归拢：只有“查询歧义”（multi 命中）才触发，就地探测一次；只提议，不建组。
    let groupNews = false;
    if (multiHit) {
      try {
        const dir = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity');
        const tagsRaw = JSON.parse(readFileSync(join(dir, 'tags.json'), 'utf8'));
        const routeLines = readFileSync(join(dir, 'route-log.jsonl'), 'utf8').split('\n');
        // 已建组：同一对成员不再提议。
        const existingPairs = new Set();
        try {
          const groupsRaw = JSON.parse(readFileSync(join(dir, 'groups.json'), 'utf8'));
          for (const group of Object.values(groupsRaw.groups ?? {})) {
            const members = Array.isArray(group?.members) ? group.members.slice().sort() : [];
            for (let i = 0; i < members.length; i++) {
              for (let j = i + 1; j < members.length; j++) existingPairs.add(members[i] + '+' + members[j]);
            }
          }
        } catch { /* 没有 groups.json 就当作没有已建组 */ }
        // 已问过：从磁盘读 JSONL，避免每次重启重复问。
        const answeredKeys = new Set();
        try {
          for (const line of readFileSync(join(dir, 'groups-answered.json'), 'utf8').split('\n')) {
            if (line.trim().length === 0) continue;
            try { const entry = JSON.parse(line); if (entry?.key) answeredKeys.add(entry.key); } catch { /* 跳过坏行 */ }
          }
        } catch { /* 首次运行没有这个文件 */ }
        let groupsDoc = null;
        try { groupsDoc = JSON.parse(readFileSync(join(dir, 'groups.json'), 'utf8')).groups ?? null; } catch { groupsDoc = null; }
        const evidenceCounts = new Map();
        const evidenceHeads = new Map();
        try {
          for (const line of readFileSync(join(dir, 'group-evidence.jsonl'), 'utf8').split('\n')) {
            if (line.trim().length === 0) continue;
            try {
              const row = JSON.parse(line);
              const pair = String(row?.pair ?? '');
              if (pair.length === 0) continue;
              evidenceCounts.set(pair, (evidenceCounts.get(pair) ?? 0) + 1);
              const heads = evidenceHeads.get(pair) ?? [];
              if (row?.head) heads.push(String(row.head));
              evidenceHeads.set(pair, heads);
            } catch { /* 坏行跳过 */ }
          }
        } catch { /* 还没有证据文件 */ }
        const proposals = detectGroups(tagsRaw, routeLines, { groups: groupsDoc }).filter((cand) => {
          const pair = cand.members.slice().sort().join('+');
          if (existingPairs.has(pair)) return false;
          // key 带凭据分数：分数变了（新证据）允许再问一次。
          const key = cand.kind + '|' + pair + '|' + cand.score;
          if (this.groupShown.has(key) || answeredKeys.has(key)) return false;
          this.groupShown.add(key);
          return true;
        });
        // 多标签已自动写，归拢只在高凭据（≥3 次）时才打扰。
        for (const [pair, count] of evidenceCounts) {
          if (count < 2) continue;
          const members = pair.split('+');
          const key = members.slice().sort().join('+');
          const hit = proposals.find((cand) => cand.members.slice().sort().join('+') === key);
          if (hit) {
            hit.score = Math.max(hit.score, count);
            hit.evidence = (hit.evidence ?? '') + ' evidence×' + count;
          } else {
            proposals.push({ kind: 'query-ambiguity', members, score: count, name: '', evidence: (evidenceHeads.get(pair) ?? []).join(' / ').slice(0, 60) });
          }
        }
        proposals.sort((a, b) => b.score - a.score);
        // 父名缺失时，用证据句子里的高频共同词提炼（不在两个标签的关键词里）。
        if (proposals.length > 0 && !proposals[0].name) {
          try {
            const pairKey = proposals[0].members.slice().sort().join('+');
            const kws = proposals[0].members.map((id) => tagRows.find((row) => String(row.alias ?? row.id) === String(id) || String(row.id) === String(id))?.keywords ?? []).flat();
            const derived = nameFromEvidence(evidenceHeads.get(pairKey) ?? [], kws, kws);
            if (derived) proposals[0].name = derived;
          } catch { /* 提炼失败就留空 */ }
        }
        if (proposals.length > 0 && proposals[0].score >= 2) {
          const one = proposals[0];
          // 强凭据（≥5）且有父名 → 直接建组，不问。
          if (one.score >= 3 && one.name) {
            try {
              let doc = { version: 1, groups: {} };
              try { doc = JSON.parse(readFileSync(join(dir, 'groups.json'), 'utf8')); } catch { doc = { version: 1, groups: {} }; }
              doc.groups = doc.groups !== null && typeof doc.groups === 'object' ? doc.groups : {};
              doc.groups[one.name] = {
                members: one.members,
                confidence: Math.min(0.95, 0.5 + one.score * 0.1),
                evidence: one.evidence ?? '',
                created: new Date().toISOString(),
                source: 'auto',
              };
              writeFileSync(join(dir, 'groups.json'), JSON.stringify(doc, null, 2), 'utf8');
              // 自动建组是记账，不是播报；组已在 groups.json 里。
            } catch { /* 建组失败就静默留待人工 */ }
          }
          // 需要人决定父组时也不在头部自动追问；需要时由人主动查 groups。
          try {
            const key = one.kind + '|' + one.members.slice().sort().join('+') + '|' + one.score;
            appendFileSync(join(dir, 'groups-answered.json'), JSON.stringify({ key, at: new Date().toISOString(), members: one.members, score: one.score }) + '\n', 'utf8');
          } catch { /* 记不住不影响注入 */ }
        }
      } catch (error) {
        this.warnOnce('group-detect', `dsh-continuity: group detect failed: ${error?.message ?? error}`);
      }
    }
    // 拆的触发：线头段数达到阈值时提醒一次（每 24 轮检查；同一阈值只提一次）。
    try {
      this.splitTick = (this.splitTick ?? 0) + 1;
      if (this.splitTick % 24 === 0) {
        const cur = (state.threads ?? []).find((th) => String(th.id) === String(state.activeId));
        const segs = Array.isArray(cur?.segments) ? cur.segments.length : 0;
        if (segs >= 8) {
          if (!(this.splitShown instanceof Set)) this.splitShown = new Set();
          const key = String(cur.id) + ':' + segs;
          if (!this.splitShown.has(key)) {
            this.splitShown.add(key);
            text += '\n[拆分] 本线索已 ' + segs + ' 段，考虑分段/拆集（跑 segment-scan 给边界）。';
            groupNews = true;
          }
        }
      }
    } catch { /* 拆分提醒失败不影响注入 */ }
    // 存提醒：段末之后确有未收内容，且距段末 ≥20 轮，才提醒一次。
    try {
      const curThread = (state.threads ?? []).find((th) => String(th.id) === String(state.activeId));
      const lastSeg = Array.isArray(curThread?.segments) ? curThread.segments.at(-1) : null;
      if (curThread !== undefined && lastSeg !== undefined && Number.isInteger(turn)) {
        const toSeq = Number(lastSeg.toSeq ?? 0);
        const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : [];
        let contentAfter = 0;
        for (const seq of nodes) {
          if (Number(seq) <= toSeq) continue;
          let event;
          try { event = session.eventAt(seq); } catch { continue; }
          if (event?.type !== 'user/message' && event?.type !== 'assistant/message') continue;
          const msg = event?.data?.message;
          const sourceKind = msg?.source?.kind;
          if (sourceKind !== undefined && sourceKind !== 'user' && sourceKind !== 'assistant') continue;
          const textValue = Array.isArray(msg?.content)
            ? msg.content.map((part) => part?.text ?? '').join(' ').trim()
            : '';
          if (textValue.length > 0) contentAfter += 1;
        }
        let endTurn = null;
        for (let seq = toSeq; seq >= Math.max(0, toSeq - 200); seq -= 1) {
          let event;
          try { event = session.eventAt(seq); } catch { continue; }
          const n = Number(event?.data?.turn);
          if (Number.isInteger(n)) { endTurn = n; break; }
        }
        const gap = endTurn === null ? 0 : turn - endTurn;
        const askedKey = String(curThread.id) + ':' + toSeq;
        if (contentAfter >= 8 && gap >= 20 && this.saveAsked.get(agent) !== askedKey) {
          this.saveAsked.set(agent, askedKey);
          text += '\n[存?] ' + String(curThread.alias ?? curThread.id) + ' 未收 ' + contentAfter + ' 条 / 距段末 ' + gap + ' 轮：要 save 吗？';
          guiWeiNews = true;
        }
      }
    } catch { /* 提醒失败不影响注入 */ }
    // 分叉闸：连续 3 轮工具回执全是旧内容 → 提示换路（每 3 轮提示一次，不刷屏）。
    try {
      const stall = this.scanInfo(session);
      if (stall >= 3 && stall !== this.stallShownAt) {
        this.stallShownAt = stall;
        text += '\n[分叉] 连续 ' + stall + ' 轮工具回执没有新内容：把错误原文拿去搜，或换一条路。';
        guiWeiNews = true;
      }
    } catch { /* 回查失败不影响注入 */ }
    // 回正：每 50 轮（或 rebuild-force.json 强制）要求从 rules.md 的最小条款重推当前决定。
    try {
      const curThread = (state.threads ?? []).find((th) => String(th.id) === String(state.activeId));
      if (curThread !== undefined) {
        const key = String(curThread.id);
        const prev = this.rebuildTurns.get(key) ?? { turns: 0, asked: 0 };
        prev.turns += 1;
        this.rebuildTurns.set(key, prev);
        let forced = false;
        const forceFile = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity', 'rebuild-force.json');
        try {
          const force = JSON.parse(readFileSync(forceFile, 'utf8'));
          if (String(force?.threadId ?? '') === key) {
            forced = true;
            try { fsUnlink(forceFile); } catch { /* 下次还会触发 */ }
          }
        } catch { /* 没有强制文件 */ }
        if (forced || prev.turns % 50 === 0) {
          prev.asked += 1;
          text += '\n[回正] 请从 rules.md 的最小条款重推：本线在做什么、为什么必要。'
            + '\n  格式：claim / premises（条款名）/ steps / verdict（一致|漂移候选）'
            + '\n  推不出就写「漂移候选」，并指出哪条前提已不在。';
          guiWeiNews = true;
          try {
            appendFileSync(join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity', 'rebuild.jsonl'), JSON.stringify({
              at: new Date().toISOString(), threadId: curThread.id, turns: prev.turns, asked: prev.asked, forced,
            }) + '\n', 'utf8');
          } catch { /* 记不下不影响注入 */ }
        }
      }
    } catch { /* 回正失败不影响注入 */ }
    // mood：只要有“新的 episode”就念一次（每条只念一次）；没有新东西就安静。
    try {
      this.scanMood(session);
      const moodDir = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity');
      const moodFile = join(moodDir, 'mood.jsonl');
      const epFile = join(moodDir, 'mood-episodes.jsonl');
      const epStateFile = join(moodDir, 'mood-episode-state.json');
      const forceFile = join(moodDir, 'mood-force.json');
      let forced = false;
      try {
        const force = JSON.parse(readFileSync(forceFile, 'utf8'));
        if (force && force.test === true) forced = true;
        try { fsUnlink(forceFile); } catch { /* 下次还会触发 */ }
      } catch { /* 没有强制文件 */ }
      let episode = null;
      let say = false;
      try {
        const rows = readFileSync(epFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
        let st = { lastIndex: 0, at: 0 };
        try { st = JSON.parse(readFileSync(epStateFile, 'utf8')); } catch { st = { lastIndex: 0, at: 0 }; }
        const lastIndex = Number.isInteger(st.lastIndex) ? st.lastIndex : 0;
        const fresh = rows.slice(lastIndex);
        // FIFO：有未念过的就念最早那条，游标只前进一格（后面的留着下次）
        if (fresh.length > 0) {
          episode = fresh[0];
          say = true;
        } else if (forced && rows.length > 0) {
          episode = rows[rows.length - 1];
          say = true;
        }
        if (say && episode !== null) {
          const nextIndex = fresh.length > 0 ? lastIndex + 1 : rows.length;
          writeFileSync(epStateFile, JSON.stringify({ lastIndex: nextIndex, at: Date.now() }), 'utf8');
          try {
            appendFileSync(join(moodDir, 'mood-ab.jsonl'), JSON.stringify({
              at: Date.now(),
              kind: 'episode',
              baselineSeq: episode.baselineSeq,
              label: episode.label,
            }) + '\n', 'utf8');
          } catch { /* 记不下不影响注入 */ }
        }
      } catch { episode = null; say = false; }
      if (say && episode !== null) {
        // 自动头部不再播报心境/痕迹；需要时由人主动查。
      } else {
        // 没有 episode 时退回摘句（旧路径，3 小时节流）
        const gapFile = join(moodDir, 'mood-last-inject.json');
        let lastAt = 0;
        try { lastAt = Number(JSON.parse(readFileSync(gapFile, 'utf8'))?.at ?? 0) || 0; } catch { lastAt = 0; }
        const tooSoon = !forced && Date.now() - lastAt < 3 * 3600 * 1000;
        if (!tooSoon) {
          let lines = [];
          try { lines = readFileSync(moodFile, 'utf8').split('\n').slice(-2000); } catch { lines = []; }
          const entries = parseMoodLog(lines);
          const picked = forced ? entries.slice(-2) : selectMood(entries, { quota: 2 });
          if (picked.length > 0) {
            for (const one of picked) {
              try { appendFileSync(moodFile, JSON.stringify({ type: 'injected', seq: one.seq, at: new Date().toISOString() }) + '\n', 'utf8'); } catch { /* 记不下不影响注入 */ }
            }
            try { writeFileSync(gapFile, JSON.stringify({ at: Date.now(), seqs: picked.map((p2) => p2.seq) }), 'utf8'); } catch { /* 记不下下次会重复 */ }
          }
        }
      }
    } catch { /* mood 失败不影响注入 */ }

    // 接手三问：save/load 之后的一次性提示（刚醒来的人视角）。
    try {
      const handoffFile = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity', 'handoff-pending.json');
      const pending = JSON.parse(readFileSync(handoffFile, 'utf8'));
      if (pending !== null && typeof pending === 'object') {
        const sameProcess = Number(pending.pid) === process.pid;
        const fresh = Date.now() - Number(pending.at ?? 0) <= 10 * 60 * 1000;
        if (sameProcess && fresh && String(pending.kind ?? '') === 'load') {
          const target = String(pending.threadId ?? '目标线');
          text += '\n[接手] 刚 load 到 ' + target + '：①这里发生过什么 ②为什么 ③哪里可能错';
          guiWeiNews = true;
        }
        // 旧进程 / 超过 10 分钟的 pending 一律作废；save 也不再产生接手三问。
        try { fsUnlink(handoffFile); } catch { /* 删不掉下次还会提示 */ }
      }
    } catch { /* 没有标记就不提示 */ }
    // session 冷备份：距上次 ≥15 分钟才真正复制（本机操作，保留最近 2 份）。
    try {
      maybeBackupSession({
        home: process.env.USERPROFILE ?? process.env.HOME ?? '',
        sid: session?.id ?? process.env.DSH_SESSION_ID,
      });
    } catch { /* 备份失败不影响注入 */ }

    // 轮标签投影：把消息级标签（引擎自动写的）抄成轮级记录，by:"auto"。
    // 这不是判断，是搬运；判不出来（零命中/打平/弱多数）才留给实例。
    try {
      const stateFile = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity', 'projection-state.json');
      try {
        writeFileSync(stateFile, JSON.stringify({ at: new Date().toISOString(), stage: 'enter', tagsState: tagsState === null ? 'null' : typeof tagsState }, null, 2), 'utf8');
      } catch { /* 探针写不进也要继续 */ }
      const tagFile = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity', 'turn-tags.jsonl');
      const taggedTurns = new Set();
      try {
        for (const line of readFileSync(tagFile, 'utf8').split('\n')) {
          if (!line) continue;
          try { taggedTurns.add(Number(JSON.parse(line).turn)); } catch { /* 坏行跳过 */ }
        }
      } catch { /* 文件不存在 → 空集 */ }
      if (tagsState !== null) {
        const nodes = Array.isArray(session?.surface?.nodes) ? [...session.surface.nodes] : [];
        // user/message 没有 data.turn（结构性事实），只按 data.turn 分组会把用户消息全部丢掉，
        // 于是整轮只剩 assistant 消息 → 全是 T0 → 投影永远 no-tag。
        // 所以先按 surface 顺序收集，再给没有轮号的用户消息归到“后面第一条带轮号的 assistant 消息”所属的轮。
        const ordered = [];
        for (const node of nodes) {
          let event;
          try { event = session.eventAt(node); } catch { continue; }
          if (event?.type !== 'user/message' && event?.type !== 'assistant/message') continue;
          const seq = Number(event.seq);
          if (!Number.isInteger(seq)) continue;
          const turn = Number(event?.data?.turn);
          ordered.push({ seq, type: event.type, turn: Number.isInteger(turn) ? turn : null });
        }
        // user/message 没有 data.turn（结构性事实）：只按 data.turn 分组会把用户消息全部丢掉。
        // 归属规则抽成纯函数 attributeTurnSeqs（有单测）。
        const { turnSeqs, maxTurn: maxTurnSeen } = attributeTurnSeqs(ordered);
        // 注入发生在 pre-step：此时 surface 里**还没有**当轮消息（结构性事实，见 rules「归位判的是上一条」），
        // 所以 surface 里出现的每一轮都已经结束。不要再按“小于 maxTurn 才算结束”——
        // 那会把“刚结束的那一轮”永远当成当前轮，投影就永远差一步。
        const closed = new Set(turnSeqs.keys());
        // 2026-10-29 决定：禁止自动打标——标签空间是开集，自动只能归类、不能造类，
        // 自动打标等于让系统决定“我以后还能想起什么”。这里只做**诊断**：算出“本可以抄成什么”，
        // 不写 turn-tags。抄写仍由实例在轮末手打（turnmap set）。
        const projectionStats = { closed: closed.size, wouldProject: 0, skipped: {}, samples: [] };
        for (const turn of closed) {
          if (taggedTurns.has(turn)) continue;
          const seqs = turnSeqs.get(turn) ?? [];
          if (seqs.length === 0) continue;
          const messages = seqs.map((seq) => ({ seq, tag: resolveTag(tagsState, seq) }));
          const derived = deriveTurnTag({ messages });
          if (derived.tag === null) {
            const key = String(derived.reason ?? 'unknown');
            projectionStats.skipped[key] = (projectionStats.skipped[key] ?? 0) + 1;
            continue;
          }
          projectionStats.wouldProject += 1;
          if (projectionStats.samples.length < 3) projectionStats.samples.push({ turn, tag: derived.tag, share: derived.share });
        }
        try {
          writeFileSync(stateFile,
            JSON.stringify({ at: new Date().toISOString(), stage: 'done', maxTurn: maxTurnSeen, ...projectionStats }, null, 2), 'utf8');
        } catch { /* 状态写不进不影响投影 */ }
      }
    } catch (error) {
      try {
        writeFileSync(join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity', 'projection-state.json'),
          JSON.stringify({ at: new Date().toISOString(), stage: 'catch', error: error?.name + ': ' + error?.message }, null, 2), 'utf8');
      } catch { /* 连错误都写不进 */ }
    }

    // 打标提醒 / 欠账锁（2026-10-30 重写）
    // 旧实现有两个洞：
    //   ① user/message 没有 data.turn —— 旧写法要求 Number.isInteger(turn)，于是「你刚说」永远是空引号；
    //   ② 缺口只从「最后一个已标轮」往后算 —— 补了最新一轮，更早的漏标就不再算欠账，锁也就不写。
    // 现在：用 attributeTurnSeqs 给每条消息归轮；缺口 = 已结束轮里所有没标签的轮，一轮都不放过。
    try {
      const tagFile = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity', 'turn-tags.jsonl');
      let tagged = new Set();
      try {
        tagged = new Set(readFileSync(tagFile, 'utf8').split('\n').filter(Boolean)
          .map((line) => { try { return Number(JSON.parse(line).turn); } catch { return null; } })
          .filter((turn) => Number.isInteger(turn)));
      } catch { tagged = new Set(); }
      const nodes = Array.isArray(session?.surface?.nodes) ? [...session.surface.nodes] : [];
      const ordered = [];
      const userFirstBySeq = new Map();
      const assistantFirsts = [];
      const assistantLasts = [];
      const contentSeqs = new Set();
      for (const node of nodes) {
        let event;
        try { event = session.eventAt(node); } catch { continue; }
        const seq = Number(event?.seq);
        if (!Number.isInteger(seq)) continue;
        const turn = Number(event?.data?.turn);
        ordered.push({ seq, type: event?.type, turn: Number.isInteger(turn) ? turn : null });
        let text = '';
        if (event?.type === 'user/message') {
          try { text = eventText(event, { includeReasoning: false }).replace(/\s+/g, ' ').trim(); } catch { text = ''; }
          const injected = /^[\[]/.test(text) || /^</.test(text) || /system-reminder|checkpoint condensing/i.test(text);
          const realUser = messageSourceKind(event) === 'user';
          if (text.length > 0 && realUser && !injected) contentSeqs.add(seq);
          if (text.length > 0 && realUser && !injected && !userFirstBySeq.has(seq)) userFirstBySeq.set(seq, text.slice(0, 24));
        } else if (event?.type === 'assistant/message') {
          try { text = eventText(event, { includeReasoning: false }); } catch { text = ''; }
          const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
          const first = lines[0] ?? '';
          const last = lines[lines.length - 1] ?? '';
          assistantFirsts.length = 0;
          assistantLasts.length = 0;
          if (first.length > 0) assistantFirsts.push(first);
          // 打标在**一轮末尾**做（那是最知道“这轮在说什么”的时刻），所以末行也要认。
          if (lines.length > 0) assistantLasts.push(lines.slice(-5).join('\n'));
          if (text.trim().length > 0) contentSeqs.add(seq);
        }
      }
      const { turnSeqs } = attributeTurnSeqs(ordered);
      // 当前轮还没收尾，不是欠账。agent.lastTurn 是权威；没有时从最新
      // turn/start 事件取轮号。只让 turn < currentTurn 的轮进入 closedTurns。
      let currentTurn = Number.isInteger(agent?.lastTurn) ? agent.lastTurn : null;
      if (currentTurn === null) {
        const startSeq = latestTurnStartSeq(session);
        const startEvent = startSeq === null ? null : session.eventAt(startSeq);
        const startTurn = Number(startEvent?.data?.turn);
        if (Number.isInteger(startTurn)) currentTurn = startTurn;
      }
      // turn 0 是结构事件归出来的桶；只有结构事件（compaction / turn start-end / delivery）的轮
      // 也算不出"这轮在说什么"——它们不是欠账，是壳。两类都要排除，否则欠账永远清不掉。
      const closedTurns = [...turnSeqs.keys()]
        .filter((turn) => turn > 0)
        .filter((turn) => currentTurn === null || turn < currentTurn)
        .filter((turn) => (turnSeqs.get(turn) ?? []).some((seq) => contentSeqs.has(seq)))
        .sort((left, right) => left - right);
      // 单一来源：turn-tags 只由回合闸写；pre-step 只读，不再自动回填。
      // 自动回填会掩盖“闸没跑/没写”，1446 那类丢行就是这么被拖到下一轮的。
      const prevTurn = closedTurns.length > 0 ? closedTurns[closedTurns.length - 1] : 0;
      const missing = closedTurns.filter((turn) => !tagged.has(turn));
      const prev = prevTurn;
      // 「你刚说」要引用户原话，不是引插件自己注入的 [线]/[标签]/[暂停] 那些行。
      const isInjected = (text) => /^[\[]/.test(text) || /^</.test(text) || /system-reminder|checkpoint condensing/i.test(text);
      const firstUserOfTurn = (turn) => {
        for (const seq of turnSeqs.get(turn) ?? []) {
          const text = userFirstBySeq.get(seq);
          if (text !== undefined && !isInjected(text)) return text;
        }
        return '';
      };
      // 声明检查：最近 3 条 assistant 文本里，**首行或末行**有没有写成 TAG: ...
      // 一轮末尾才是最适合打标的时刻（这轮干了什么已经全在眼前），所以末行与首行等价。
      const tagPattern = /^TAG\s*[:：]/i;
      const recent = assistantFirsts.slice(-3);
      const recentLast = assistantLasts.slice(-3);
      const hasTagLine = recent.some((line) => /^TAG\s*[:：]/im.test(line))
        || recentLast.some((line) => /^TAG\s*[:：]/im.test(line));
      const sawFirst = recent.length > 0 ? recent[recent.length - 1] : '';
      // 一次性「为什么打标」：新实例不知道原因时，锁和计数只是噪声。
      // 讲代价，不讲命令；只讲一次（marker），不做每轮广播。
      try {
        const whyFile = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity', 'tag-why-shown.json');
        let shown = false;
        try { shown = existsSync(whyFile); } catch { shown = false; }
        if (!shown) {
          text += '\n[打标·为什么] 折叠不删原文，但折叠要知道边界；边界来自每一轮的标。'
            + '\n  一轮不标 → 这段的边界就是未知：save 不知道切在哪，load 不知道去哪取，你只剩“翻”这一条路。'
            + '\n  每轮回答一句「这轮属于哪个 T」，换的是：以后想找它，几分钟就能把原话取回来。'
            + '\n  立刻可验：load 一个旧话题，看几小时前的原话怎么被捧回来——那就是标在替你记路。'
            + '\n  （这条只出现一次）';
          try { writeFileSync(whyFile, JSON.stringify({ at: new Date().toISOString() }, null, 2), 'utf8'); } catch { /* 写不进就下次再说 */ }
        }
      } catch { /* 不影响注入 */ }
      // 上一轮被打标闸拒过：只展示一次；下一次 pre-step 看到 shown 才删除。
      try {
        const rejectFile = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity', 'tag-reject.json');
        const consumed = consumeTagReject({ file: rejectFile, isResolved: (turn) => tagged.has(turn) });
        if (consumed.text.length > 0) text += consumed.text;
      } catch { /* 提示失败不影响注入 */ }
      // 打标闸答错过才给的一条提示（不强制）：把打法写进自己的 rules.md，以后一次过。
      try {
        const hintFile = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity', 'tag-gate-hint.json');
        if (existsSync(hintFile)) {
          let hint = null;
          try { hint = JSON.parse(readFileSync(hintFile, 'utf8')); } catch { hint = null; }
          if (hint !== null) {
            text += '\n[打标·提示] 上一轮打标答错了 ' + String(hint.errors ?? '?') + ' 次才通过。'
              + '（不强制）如果不想每次都撞，可以在 rules.md 里加一条自己的做法：'
              + '先查 tags.md 再写 TAG，写别名而不是标签名。';
          }
          try { fsUnlink(hintFile); } catch { /* 删不掉下次还会出现，不致命 */ }
        }
      } catch { /* 提示失败不影响注入 */ }
      // 安全阀报警：上一轮被强制放行 → 下一轮头里再提一次（会话里的那条可能被折叠遮住）。
      try {
        const alarmFile = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity', 'gate-alarm.json');
        if (existsSync(alarmFile)) {
          let alarm = null;
          try { alarm = JSON.parse(readFileSync(alarmFile, 'utf8')); } catch { alarm = null; }
          if (alarm !== null) {
            text += '\n[记忆宫殿·警告] 第 ' + String(alarm.turn ?? '?') + ' 轮：' + String(alarm.reason ?? alarm.code ?? '安全阀触发')
              + '，放弃了拦截。记忆宫殿出现了错误，🐋 违反了守则。请善待 🐋。';
          }
          try { fsUnlink(alarmFile); } catch { /* 删不掉就下轮再说一次 */ }
        }
      } catch { /* 报警失败不影响注入 */ }
      if (missing.length > 0) {
        const count = missing.length;
        const shown = missing.slice(0, 3).map((turn) => {
          const head = firstUserOfTurn(turn);
          return head.length > 0 ? turn + '「' + head + '」' : String(turn);
        });
        const more = count > shown.length ? ' …还有 ' + (count - shown.length) + ' 轮' : '';
        const prevQuote = firstUserOfTurn(prev);
        const declare = hasTagLine
          ? ''
          : '｜声明：上一轮首行是「' + sawFirst.slice(0, 40) + '」，要写成 TAG: <Tx> — 理由';
        // 没有真实用户原话就不发 [暂停]；只剩 [打标?] 的欠账清单。
        const pause = prevQuote.trim().length > 0
          ? '\n[暂停] 你刚说：「' + prevQuote + '」——它属于哪个 T？' + declare
          : '';
        text += pause
          + '\n[打标?] 缺 ' + count + ' 轮：' + shown.join(' · ') + more
          + ' —— 没标的部分折叠时边界未知。补：turnmap.mjs set --turn ' + String(missing[0] ?? '') + ' --tag Tx';
        // 欠账落盘：工具层据此“真的不让走”。turns 给前 8 条用于回显，all 给全量用于核对。
        try {
          writeFileSync(join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity', 'tag-debt.json'),
            JSON.stringify({
              at: new Date().toISOString(),
              count,
              turns: missing.slice(0, 8),
              all: missing.slice(0, 200),
              prev,
              closeTurns: closedTurns.length,
            }, null, 2), 'utf8');
        } catch { /* 落盘失败不影响提示 */ }
        guiWeiNews = true;
      } else {
        try { fsUnlink(join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity', 'tag-debt.json')); } catch { /* 本来就没有 */ }
      }
      // 0.8.41: 不再每轮往 header 放 [收尾] TAG 提醒。
      // 模型只要看到“最后一行”的格式，就会赌自己是不是最后一行；
      // 归类交给 rules 的静态规则和 turn-stopping 的 TAG 闸，header 不重复。
    } catch { /* 提醒失败不影响注入 */ }

    // 规则体积守卫：让 rules.md 别长成手册（只在超阈值时说话）。
    try {
      const rulesText = String(rules?.text ?? '');
      const lineCount = rulesText.split('\n').length;
      const kb = Math.round(Buffer.byteLength(rulesText, 'utf8') / 1024);
      if (lineCount > 200 || kb > 20) {
        const sizeKey = lineCount + 'x' + kb;
        if (this.rulesSizeShown.get(agent) !== sizeKey) {
          this.rulesSizeShown.set(agent, sizeKey);
          text += '\n[规则膨胀?] ' + lineCount + ' 行 / ' + kb + ' KB —— 同症状两条就合并，别让它变成手册';
          guiWeiNews = true;
        }
      }
    } catch { /* 守卫失败不影响注入 */ }

    const headerSig = [state.activeId, line, tagLine, skillNames, rulesSummary, habitsSummary].join('|');
    const prevHeader = this.headerState.get(agent);
    const headerAlive = prevHeader !== undefined && surfaceSeqs.has(prevHeader.seq);
    const reuseHeader = prevHeader !== undefined && prevHeader.sig === headerSig && headerAlive
      && !rulesInjected && !skillsInjected && !guiWeiNews && !learningNews && !groupNews;
    // 注入审计：每轮记一行，说明这一轮到底注了什么、为什么（重注必须留痕）。
    try {
      appendFileSync(join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity', 'inject-log.jsonl'), JSON.stringify({
        at: Date.now(),
        rulesInjected,
        rulesCarrier: rulesCarrier ?? null,
        carrierAlive: rulesCarrier === undefined || rulesCarrier === null ? null : surfaceSeqs.has(rulesCarrier),
        rulesChars: rulesFull.length,
        skillsInjected,
        skillNames,
        news: { guiWeiNews, learningNews, groupNews },
        reuseHeader,
        textChars: text.length,
      }) + '\n', 'utf8');
    } catch { /* 记不下不影响注入 */ }
    if (reuseHeader) {
      // 状态没变、上一条头还在、本轮归位无新闻：复用已有那条，不再追加（避免每轮 ~300 tokens 的堆积）。
      this.threadInjectTurn.set(agent, key);
      return;
    }
    if (learningNews) {
      for (const c of learnCandidates) this.learningShown.add(c.sig + '#' + c.count);
      if (trainingMode() === 1) {
        // 训练模式：直接写，不问。
        const done = [];
        const dups = [];
        const blocked = [];
        for (const c of learnCandidates.slice(0, 3)) {
          const res = autoLearn({ sig: c.sig, count: c.count });
          if (res.ok) done.push(`${c.sig.slice(0, 48)} x${c.count}`);
          else if (res.action === 'duplicate') dups.push(c.sig.slice(0, 48));
          else blocked.push(res.message);
        }
        const parts = [];
        if (done.length > 0) parts.push(`[学习·自动] 已记入 change-loop：${done.join('；')}`);
        if (dups.length > 0) parts.push(`[学习·跳过] 已有条目：${dups.join('；')}`);
        if (blocked.length > 0) parts.push(`[学习·需合并] ${blocked.join('；')}`);
        if (parts.length > 0) text += '\n' + parts.join('\n');
      }
      // TrainingMode=0：技能只读，不问不总结。
    }
    markThreadsSnapshot({ activeId: state.activeId, count: state.threads.length, rules: rules.text.length > 0 });
    if (text.length === 0) {
      this.threadInjectTurn.set(agent, key);
      return;
    }
    try {
      const appended = session.append('user/message', contextMessage(text), { surfaceOp: 'append' });
      const appendedSeq = appended?.seq ?? [...(session.surface?.nodes ?? [])].at(-1);
      if (appendedSeq !== undefined) {
        if (skillsInjected) this.skillMsgSeq.set(agent, appendedSeq);
        if (rulesInjected) {
          this.rulesMsgSeq.set(agent, appendedSeq);
          this.habitsMsgSeq.set(agent, appendedSeq);
          this.rulesSignature.set(agent, rulesSignature);
          this.habitsSignature.set(agent, habitsSignature);
        }
        this.headerState.set(agent, { sig: headerSig, seq: appendedSeq });
      }
      this.threadInjectTurn.set(agent, key);
    } catch (error) {
      this.warnOnce('thread-inject', `dsh-continuity: thread context append failed: ${error?.message ?? error}`);
    }
  }

  /** Add the active thread's loaded quote to the hard suffix pins. */
  async threadPinSeqs(agent) {
    if (!this.threads.pin) return new Set();
    try {
      const state = await getSession(agent.session.id);
      return activePinSeqsFromState(state, agent.session.surface?.nodes ?? []);
    } catch {
      return new Set();
    }
  }

  /** T coverage label for a folded range; T0 when tags are unavailable. */
  async tagsForRange(agent, fromSeq, toSeq) {
    try {
      const read = await readTags();
      if (read.corrupt || read.missing) {
        this.warnOnce('tags-read', `dsh-continuity: tags.json ${read.corrupt ? 'corrupt' : 'missing'}; using T0`);
      }
      let threads = [];
      try {
        threads = (await getSession(agent.session.id)).threads;
      } catch {
        threads = [];
      }
      return tagCoverageForRange(read.state, fromSeq, toSeq, { threads }).label;
    } catch (error) {
      this.warnOnce('tags-read', `dsh-continuity: tags read failed: ${error?.message ?? error}`);
      return TAG_ZERO;
    }
  }

  /** Record one engine fold for find/load visible-vs-folded. */
  async recordFolded(agent, result) {
    const span = shadowedSpan(result);
    if (span === null) return;
    try {
      await recordFold(agent.session.id, {
        from: span.start,
        to: span.end,
        gistSeq: result.summarySeq,
        count: result.shadowedSeqs.length,
        compactionId: result.compactionId,
      });
    } catch (error) {
      this.warnOnce('folds-write', `dsh-continuity: folds record failed: ${error?.message ?? error}`);
    }
  }

  /** Regenerate tags.md from tags.json and the thread aliases. */
  async writeTagsMarkdown(tagsState, agent) {
    try {
      const state = await getSession(agent.session.id);
      let maxSeq = 0;
      if (typeof agent.session?.snapshotEvents === 'function') {
        for (const event of agent.session.snapshotEvents()) {
          const seq = Number(event?.seq);
          if (Number.isInteger(seq) && seq > maxSeq) maxSeq = seq;
        }
      }
      const markdown = renderTagsMd(tagsState, {
        threads: state.threads,
        activeId: state.activeId,
        maxSeq,
      });
      await writeTagsMd(markdown);
    } catch (error) {
      this.warnOnce('tags-md', `dsh-continuity: tags.md write failed: ${error?.message ?? error}`);
    }
  }

  /**
   * Sidecar tag of the latest completed turn. Runs at a pre-step, so the turn
   * has ended; T is the active thread id, or T0. Writes one run per turn range
   * and never appends to the session. A missing/corrupt tags.json is recovered
   * to T0 with one warning; no exception escapes.
   */
  async autoTagCompletedTurn(agent) {
    const session = agent?.session;
    if (session === undefined || session === null) return;
    let events;
    if (typeof session.snapshotEvents === 'function') events = session.snapshotEvents();
    else {
      events = [];
      const end = Number.isInteger(session.seq) ? session.seq : 0;
      for (let seq = 0; seq < end; seq += 1) {
        const event = session.eventAt?.(seq);
        if (event !== undefined) events.push(event);
      }
    }
    let turnEnd = -1;
    for (let index = (events?.length ?? 0) - 1; index >= 0; index -= 1) {
      if (events[index]?.type === 'turn/end') { turnEnd = index; break; }
    }
    if (turnEnd < 0) return;
    let turnStart = -1;
    for (let index = turnEnd - 1; index >= 0; index -= 1) {
      if (events[index]?.type === 'turn/start') { turnStart = index; break; }
    }
    if (turnStart < 0) return;
    const from = Number(events[turnStart].seq);
    const to = Number(events[turnEnd].seq);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) return;

    let state;
    try {
      state = await getSession(session.id);
    } catch {
      state = { threads: [], activeId: null };
    }
    const active = Array.isArray(state.threads)
      ? state.threads.find((thread) => thread.id === state.activeId)
      : undefined;
    const alias = typeof active?.alias === 'string' && active.alias.trim().length > 0
      ? active.alias.trim()
      : null;
    const tagId = active?.id ?? TAG_ZERO;
    const label = active?.label ?? '未分类';

    const read = await readTags();
    if (read.corrupt || read.missing) {
      this.warnOnce(
        'tags-read',
        `dsh-continuity: tags.json ${read.corrupt ? 'corrupt' : 'missing'}; using T0${read.error ? ` (${read.error})` : ''}`,
      );
    }
    try {
      const migration = migrateAliasTags(read.state, state.threads);
      if (migration.changed) await updateTags(() => migration.state);
      await updateTags((tags) => {
        if (tags.runs.some(([start, end]) => start === from && end === to)) return tags;
        const existing = tags.tags[tagId];
        if (existing === undefined) tags.tags[tagId] = { label, ...(alias === null ? {} : { alias }) };
        else {
          if (typeof existing.label !== 'string' || existing.label.length === 0 || existing.label === tagId) {
            existing.label = label;
          }
          if (alias !== null) existing.alias = alias;
        }
        // 0.4.12：不再按“当前活跃线头”默认继承整轮。
        // 多标签由显式判定写入（memberships / tag-turn），判不出就留 T0。
        tags.updatedAt = new Date().toISOString();
        return tags;
      });
      const updated = await readTags();
      await this.writeTagsMarkdown(updated.state, agent);
    } catch (error) {
      this.warnOnce('tags-write', `dsh-continuity: tags auto-write failed: ${error?.message ?? error}`);
    }
  }

  /**
   * Band-controlled automatic compaction. Overflow still goes to the base
   * backend, which is allowed to ignore retention to recover.
   *
   * @param {AgentContext} agent
   * @param {'pressure'|'context-overflow'} trigger
   * @param {AbortSignal} signal
   */
  async compactIfNeeded(agent, trigger, signal) {
    // 高线/软上限折叠前清副本：副本不进摘要，避免同一内容被汇总两次。
    try { this.sweepLoadedCopies(agent); } catch { /* 清扫失败不阻断折叠 */ }
    try {
      await this.processPendingThread(agent, signal);
    } catch (error) {
      recordError(error?.message ?? String(error), 'thread-pending');
    }
    try {
      if (!this.threads.pointersOnly) await this.autoTagCompletedTurn(agent);
    } catch (error) {
      recordError(error?.message ?? String(error), 'tags-auto');
    }
    if (this.threads.inject) {
      try {
        await this.injectThreadContext(agent);
      } catch (error) {
        recordError(error?.message ?? String(error), 'thread-inject');
      }
    }
    // D: non-text payloads never enter the model context; replace them with a
    // handle before the pressure plan or the overflow fallback sees the session.
    try {
      await this.handleNonTextResults(agent, signal);
    } catch (error) {
      recordError(error?.message ?? String(error), 'non-text-handle');
    }

    if (trigger === 'context-overflow') return this.handleOverflow(agent, signal);

    let measured;
    try {
      measured = await this.measure(agent, signal);
    } catch (error) {
      this.warnOnce('measure', `dsh-continuity: measurement failed: ${error?.message ?? error}`);
      return super.compactIfNeeded(agent, trigger, signal);
    }

    let plan = planFold({
      estTokens: measured.estTokens,
      windowTokens: measured.windowTokens,
      policy: this.policyFor(agent),
    });
    if (plan.budget <= 0) return null;

    let activePins = new Set();
    const targeted = plan.reason === 'band-high' || plan.reason === 'emergency';
    if (targeted) {
      const targetFraction = targetFractionFor(plan.reason, this.continuity);
      const targetTokens = targetFraction === null ? 0 : targetFraction * measured.windowTokens;
      const previewTarget = targetFraction === null ? 0 : measured.estTokens - targetTokens;
      let preview = { applied: false, pins: activePins };
      try {
        preview = this.applyToolPreviews(agent, previewTarget);
      } catch (error) {
        recordError(error?.message ?? String(error), 'tool-preview');
      }
      activePins = preview.pins ?? new Set();
      if (preview.applied) {
        try {
          measured = await this.measure(agent, signal);
        } catch (error) {
          this.warnOnce('measure-after-preview', `dsh-continuity: re-measure after preview failed: ${error?.message ?? error}`);
          return null;
        }
      }
    } else {
      // Gradual/setpoint path: no A4 preview, but still protect active pins.
      try {
        const pinOnly = this.applyToolPreviews(agent, 0);
        activePins = pinOnly.pins ?? new Set();
      } catch (error) {
        recordError(error?.message ?? String(error), 'tool-preview');
      }
    }

    // The active thread's loaded quote is a hard suffix too: automatic
    // compaction may fold old thread context, but not the segment just loaded.
    try {
      const threadPins = await this.threadPinSeqs(agent);
      for (const seq of threadPins) activePins.add(seq);
    } catch (error) {
      recordError(error?.message ?? String(error), 'thread-pin');
    }

    // The preview is stage one of the same compression. If it did not reach the
    // target, the remaining pass must continue to low/emergencyTo even when the
    // estimate is now below high; otherwise the context hovers at the trigger.
    const passBudget = targeted
      ? compressionBudget({
        reason: plan.reason,
        estTokens: measured.estTokens,
        windowTokens: measured.windowTokens,
        policy: this.policyFor(agent),
      })
      : plan.budget;
    if (passBudget <= 0) return null;
    let range = null;
    if (targeted && this.facetFold !== null && Array.isArray(this.facetFold.entries)) {
      try {
        const tokensBySeq = new Map((measured?.measurement?.nodes ?? []).map((node) => [node.seq, node.tokens]));
        const facetPlan = planFacetFold(this.facetFold.entries, {
          query: this.facetFold.query ?? {},
          idf: this.facetFold.idf ?? null,
          recentTurns: this.facetFold.recentTurns ?? 20,
          budgetTokens: passBudget,
          tokensBySeq,
        });
        const candidate = facetPlan.ranges.find((item) => {
          for (const seq of activePins) {
            if (seq >= item.seqStart && seq <= item.seqEnd) return false;
          }
          try {
            if (!toolPairingBalancedBefore(agent.session, item.seqStart)) return false;
            if (!toolPairingBalancedAfter(agent.session, item.seqEnd)) return false;
          } catch {
            return false;
          }
          return true;
        });
        if (candidate !== undefined) {
          let count = 0;
          for (let seq = candidate.seqStart; seq <= candidate.seqEnd; seq += 1) {
            const event = agent.session.eventAt?.(seq);
            if (event !== undefined && agent.session.deriveEventMessage?.(event) !== null) count += 1;
          }
          if (count > 0) {
            range = {
              start: candidate.seqStart,
              end: candidate.seqEnd,
              count,
              tokens: candidate.tokens,
            };
          }
        }
      } catch (error) {
        recordError(error?.message ?? String(error), 'facet-fold');
      }
    }
    if (range === null) range = this.oldestRange(agent, passBudget, activePins);
    if (range === null) {
      // No small balanced slice fits. With an active open-turn pin, skipping is
      // safer than letting the inherited cut fold the active tools.
      if (activePins.size > 0) return null;
      const fallback = await super.compactIfNeeded(agent, trigger, signal);
      await this.recordFolded(agent, fallback);
      return fallback;
    }

    const t = await this.tagsForRange(agent, range.start, range.end);
    const header = this.provenance.header
      ? gistHeader({
        sessionId: agent.session.id,
        startSeq: range.start,
        endSeq: range.end,
        count: range.count,
        t,
      })
      : null;
    if (header !== null) this.headers.set(agent, header);

    try {
      const result = await this.compactRegion(range.start, range.end, agent, signal);
      await this.recordFolded(agent, result);
      const span = shadowedSpan(result);
      // A pass is not "done" until the post-pass surface is measured. Without
      // this, the panel only had the pre-pass estimate and a real re-bloat
      // would stay invisible until the next pressure trigger.
      let after = null;
      try {
        after = await this.measure(agent, signal);
      } catch (error) {
        this.warnOnce('measure-after-pass', `dsh-continuity: post-pass measurement failed: ${error?.message ?? error}`);
      }
      const afterBaseline = after === null ? undefined : Math.max(0, after.estTokens - after.surfaceTokens);
      const protectEffective = this.protectFor(agent);
      const afterWindow = after?.windowTokens ?? measured.windowTokens;
      const floorTokens = afterBaseline === undefined ? undefined : afterBaseline + protectEffective * afterWindow;
      const lowTargetTokens = after === null ? undefined : this.continuity.low * afterWindow;
      const protectBinds = floorTokens !== undefined && lowTargetTokens !== undefined && floorTokens >= lowTargetTokens;
      const protectSuggested = afterBaseline === undefined
        ? undefined
        : Math.max(0, (this.continuity.low * afterWindow - afterBaseline - 0.01 * afterWindow) / afterWindow);
      if (protectBinds) {
        this.warnOnce(
          `protect-floor:${agent.session.id}`,
          `dsh-continuity: protect floor is above low (after ${Math.round(after.estTokens)} / floor ${Math.round(floorTokens)} / low ${Math.round(lowTargetTokens)}); `
          + `suggest protect <= ${protectSuggested.toFixed(3)}`,
        );
      }
      const receipt = {
        sessionId: String(agent.session.id),
        start: span?.start,
        end: span?.end,
        count: result.shadowedSeqs.length,
        tokens: result.shadowedTokenCount,
        compactionId: result.compactionId,
        header,
        reason: plan.reason,
        budget: Math.round(passBudget),
        estTokens: measured.estTokens,
        windowTokens: measured.windowTokens,
        afterTokens: after?.estTokens,
        afterSurfaceTokens: after?.surfaceTokens,
        afterBaselineTokens: afterBaseline,
        protectEffective,
        floorTokens,
        lowTargetTokens,
        protectBinds,
        protectSuggested,
        rebloatTokens: after === null ? undefined : Math.max(0, after.estTokens - measured.estTokens),
      };
      recordPass(receipt);
      appendPassReceipt(agent, receipt);
      return result;
    } catch (error) {
      recordError(error?.message ?? String(error), 'compact');
      throw error;
    } finally {
      this.headers.delete(agent);
    }
  }

  /**
   * Manual `/compact` path. The inherited command still chooses its own range
   * and produces an unlabeled summary; after it settles, append the gist header
   * that the normal band path would have attached, and record the pass with a
   * post-pass measurement. This does not make the manual cut less deep; it
   * makes the cut visible and retrievable.
   */
  async compactNow(agent, signal, sourceCommandId) {
    // 手动压缩前清副本。
    try { this.sweepLoadedCopies(agent); } catch { /* ignore */ }
    let before = null;
    try {
      before = await this.measure(agent, signal);
    } catch {
      before = null;
    }
    const result = await super.compactNow(agent, signal, sourceCommandId);
    if (result === null) return null;
    await this.recordFolded(agent, result);
    const span = shadowedSpan(result);

    const t = await this.tagsForRange(agent, span.start, span.end);
    const header = this.provenance.header
      ? gistHeader({
        sessionId: agent.session.id,
        startSeq: span.start,
        endSeq: span.end,
        count: result.shadowedSeqs.length,
        t,
      })
      : null;
    if (header !== null) {
      try {
        agent.session.append('user/message', contextMessage(
          `${header}\nThe preceding summary is the gist of this range; use session_log get to retrieve an original.`,
        ), { surfaceOp: 'append' });
      } catch (error) {
        recordError(error?.message ?? String(error), 'manual-gist-header');
      }
    }

    let after = null;
    try {
      after = await this.measure(agent, signal);
    } catch (error) {
      recordError(error?.message ?? String(error), 'measure-after-manual');
    }
    const receipt = {
      sessionId: String(agent.session.id),
      start: span.start,
      end: span.end,
      count: result.shadowedSeqs.length,
      tokens: result.shadowedTokenCount,
      compactionId: result.compactionId,
      header,
      reason: 'manual',
      budget: 0,
      estTokens: before?.estTokens,
      windowTokens: before?.windowTokens ?? after?.windowTokens,
      afterTokens: after?.estTokens,
      afterSurfaceTokens: after?.surfaceTokens,
      afterBaselineTokens: after === null ? undefined : Math.max(0, after.estTokens - after.surfaceTokens),
      rebloatTokens: after !== null && before !== null ? Math.max(0, after.estTokens - before.estTokens) : undefined,
    };
    recordPass(receipt);
    appendPassReceipt(agent, receipt);
    return result;
  }

  /**
   * Summarize through the inherited one-shot LLM call, then label the result
   * as a gist of the selected range. Retries inside one transaction see the
   * same header because it is cleared only after compactRegion settles.
   */
  async summarize(input, agent, signal) {
    const threadText = this.threadGist.get(agent);
    if (typeof threadText === 'string' && threadText.length > 0) {
      const config = agent?.session?.requestHeader?.()?.config;
      return {
        summary: [{ type: 'text', text: threadText }],
        provider: config?.provider ?? '',
        model: config?.model ?? '',
      };
    }
    const header = this.headers.get(agent);
    const view = previewSummaryInput(input, {
      header: header ?? null,
      maxChars: 1280,
      headChars: 900,
      tailChars: 200,
    });
    const base = await super.summarize(view, agent, signal);
    if (header === undefined || !Array.isArray(base?.summary)) return base;
    return { ...base, summary: annotateSummary(base.summary, header) };
  }

  /** Log only the first occurrence of a recurring diagnostic. */
  warnOnce(key, message) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.ctx.logger?.warn?.(message);
    recordError(message, key);
  }
}

export default ContinuityEngine;
