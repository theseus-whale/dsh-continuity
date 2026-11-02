/**
 * Continuity threads Core + model-facing facade.
 *
 * The Core owns save/load/scan/find/tag/retag/tags/active/list. `makeApi()` is
 * the forwarding layer the tool dispatcher calls; when a Core method is added,
 * add it to the facade and exercise it through the tool, not just through a
 * static check.
 */
import { recordError } from './state.mjs';
import { eventRole } from './session-log.mjs';
import {
  continuityHome,
  getSession,
  readState,
  updateSession,
} from './threads-store.mjs';
import { readTags, updateTags, writeTagsMd } from './tags-store.mjs';
import { writeDeletedBackup } from './deleted-store.mjs';
import { contentUndecided, untaggedTurnList, turnTagGap } from './t0.mjs';
import { attributeTurnSeqs } from './turn-tag.mjs';
import { detectDeadEnds, pathFromArguments } from './deadend.mjs';
import { buildPreflight, summarizeHealth } from './preflight.mjs';
import { planSplits, runsForThread, blocksByTag } from './split-range.mjs';
import { resolveSaveStart, detectSkippedRange } from './save-start.mjs';
import {
  buildBackfillSegment,
  rangeOverlaps,
  selectBackfillEvents,
  trimBackfillEvents,
} from './backfill.mjs';
import { appendFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { foldForSeq, readFolds } from './folds-store.mjs';
import {
  findResolvedRanges,
  findTagSeqs,
  findT0Ranges,
  migrateAliasTags,
  renderTagsMd,
  retagTags,
  selectionLoadText,
  tagCoverageForRange,
  tagSeqs,
  tagsView,
  TAG_ZERO,
} from './tags.mjs';
import {
  activeView,
  applyReasoningBudget,
  estimateTextTokens,
  formatTokenCount,
  listView,
  quoteEventText,
  quoteSelected,
  quoteSelectedWithReasoning,
  REASONING_LOAD_BUDGET,
  scanEvents,
  selectLoadSegment,
  threadLoadIndexOnly,
  threadLoadText,
} from './threads.mjs';
const DEFAULT_LOAD_BUDGET = 8_000;
const MAX_LOAD_BUDGET = 20_000;

// 单测开关：假 session 没有 turn/事件数据，四道闸会把夹具误判成“缺口”。
// 只有测试进程会把它关掉；生产路径永远是 true。
let gatesEnabled = true;
export function setGatesEnabledForTests(value) { gatesEnabled = value === true; }

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`continuity.${name}: required non-empty string`);
  }
  return value.trim();
}

function optionalString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalInteger(value, name) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`continuity.${name}: must be an integer`);
  return number;
}

function integerList(value, name) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`continuity.${name}: must be a non-empty array of integer seqs`);
  }
  const seqs = value.map((entry) => Number(entry));
  if (seqs.some((seq) => !Number.isInteger(seq))) {
    throw new Error(`continuity.${name}: every entry must be an integer seq`);
  }
  return [...new Set(seqs)];
}

function budgetOf(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_LOAD_BUDGET;
  return Math.min(MAX_LOAD_BUDGET, Math.max(1, Math.trunc(number)));
}

/** Keep the requested earliest/latest selection while enforcing the budget.
 * Drops the largest visible event first; the result is sorted by seq. */
function trimSelectedToBudget(entries, budget) {
  const keep = [...entries].sort((left, right) => Number(left.seq) - Number(right.seq));
  let total = keep.reduce((sum, entry) => sum + (Number(entry.tokens) || 0), 0);
  while (keep.length > 0 && total > budget) {
    let largest = 0;
    for (let index = 1; index < keep.length; index += 1) {
      if (Number(keep[index].tokens) > Number(keep[largest].tokens)) largest = index;
    }
    total -= Number(keep[largest].tokens) || 0;
    keep.splice(largest, 1);
  }
  return keep;
}

async function readTagsWithWarning() {
  const read = await readTags();
  if (read.corrupt || read.missing) {
    recordError(
      `continuity: tags.json ${read.corrupt ? 'corrupt' : 'missing'}; using T0${read.error ? ` (${read.error})` : ''}`,
      'tags-read',
    );
  }
  return read;
}

/** alias is display only: resolve it to the canonical thread id. */
function canonicalTagId(id, threads = []) {
  const text = String(id);
  const thread = threads.find((entry) => String(entry.id) === text)
    ?? threads.find((entry) => String(entry.alias ?? '') === text);
  return thread === undefined ? text : String(thread.id);
}

/** id → existing tag id → tag/thread alias. null means unknown. */
function resolveTagIdentity(id, tagsState, threads = []) {
  const text = String(id);
  if (tagsState?.tags?.[text] !== undefined) return text;
  const aliased = Object.entries(tagsState?.tags ?? {}).find(([, entry]) => entry?.alias === text);
  if (aliased !== undefined) return aliased[0];
  const thread = threads.find((entry) => String(entry.id) === text)
    ?? threads.find((entry) => String(entry.alias ?? '') === text);
  return thread === undefined ? null : String(thread.id);
}

/** Read tags and merge any alias-named tag records into their canonical threads. */
async function readTagsMigrated(threads = []) {
  const read = await readTagsWithWarning();
  const migration = migrateAliasTags(read.state, threads);
  if (!migration.changed) return { ...read, state: migration.state, migration };
  const result = await updateTags(() => migration.state);
  return { ...read, state: result.state, migration };
}

/** Split selected entries by fold state and collect the gist seqs. */
function foldedInfo(folds, entries) {
  const folded = [];
  const visible = [];
  const gists = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const fold = foldForSeq(folds, entry.seq);
    if (fold === null) {
      visible.push(Number(entry.seq));
    } else {
      folded.push(Number(entry.seq));
      if (Number.isInteger(fold.gistSeq)) gists.add(fold.gistSeq);
    }
  }
  return {
    folded,
    visible,
    foldedNote: gists.size > 0 ? [...gists].sort((left, right) => left - right).join(',') : null,
  };
}

/** One Continuity engine/session view over the durable thread store. */
export class ThreadsCore {
  /**
   * @param {object} options
   * @param {object} options.agent
   * @param {object} options.sessionQuery
   * @param {object} [options.tokenMeter]
   * @param {{ saveThread: Function }} options.backend lazily resolved engine seam
   */
  constructor({ agent, sessionQuery, tokenMeter, backend }) {
    this.agent = agent;
    this.sessionQuery = sessionQuery;
    this.tokenMeter = tokenMeter;
    this.backend = backend;
    this.sessionId = String(agent?.session?.id ?? agent?.id ?? '');
  }

  /** 按轮标签规划切段：返回 [{tag, label, threadId, fromSeq, toSeq}] */
  async planSplit() {
    const state = await getSession(this.sessionId);
    const activeThread = (state.threads ?? []).find((thread) => String(thread.id) === String(state.activeId));
    // 全局水位：所有线头的段最远覆盖到哪。按 active 自己的 lastTo 会重复保存别人已存的区间。
    const globalLastTo = (state.threads ?? []).reduce((max, thread) => {
      const to = Number(thread?.segments?.at(-1)?.toSeq ?? 0);
      return Number.isFinite(to) && to > max ? to : max;
    }, 0);
    const lastTo = globalLastTo;
    const snapshot = await this.sessionQuery.readSession(this.agent.session.id);
    const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
    let maxTurn = -Infinity;
    for (const event of events) {
      const turn = Number(event?.data?.turn);
      if (Number.isInteger(turn) && turn > maxTurn) maxTurn = turn;
    }
    let boundary = -Infinity;
    for (const event of events) {
      const turn = Number(event?.data?.turn);
      if (!Number.isInteger(turn) || turn >= maxTurn) continue;
      const seq = Number(event?.seq);
      if (Number.isInteger(seq) && seq > boundary) boundary = seq;
    }
    if (!Number.isFinite(boundary)) return [];
    const turnRows = (() => {
      try {
        return readFileSync(join(continuityHome(), 'turn-tags.jsonl'), 'utf8').split('\n').filter(Boolean)
          .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      } catch { return []; }
    })();
    const tagOf = new Map();
    for (const row of turnRows) tagOf.set(Number(row.turn), String(row.tag));
    const byTurn = new Map();
    for (const event of events) {
      if (event?.type !== 'user/message' && event?.type !== 'assistant/message') continue;
      const turn = Number(event?.data?.turn);
      const seq = Number(event?.seq);
      if (!Number.isInteger(turn) || !Number.isInteger(seq)) continue;
      const entry = byTurn.get(turn) ?? { turn, seqs: [] };
      entry.seqs.push(seq);
      byTurn.set(turn, entry);
    }
    const covered = [];
    for (const thread of state.threads ?? []) {
      for (const seg of thread.segments ?? []) covered.push([Number(seg.fromSeq), Number(seg.toSeq)]);
    }
    const isCovered = (seq) => covered.some(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && seq >= a && seq <= b);
    const uncoveredTurns = [...byTurn.values()].map((entry) => ({
      ...entry,
      seqs: entry.seqs.filter((seq) => !isCovered(seq)),
    })).filter((entry) => entry.seqs.length > 0);
    const plan = planSplits({ turns: uncoveredTurns, tagOf, fromSeq: lastTo + 1, toSeq: boundary });
    const threads = new Map((state.threads ?? []).map((thread) => [String(thread.id), thread]));
    const fallback = activeThread?.id ?? null;
    return plan.map((part) => {
      const thread = threads.get(String(part.tag)) ?? (fallback === null ? null : threads.get(String(fallback)));
      return {
        tag: part.tag,
        label: String(thread?.label ?? part.tag),
        threadId: thread?.id ?? fallback,
        fromSeq: part.fromSeq,
        toSeq: part.toSeq,
      };
    }).filter((part) => typeof part.threadId === 'string' && part.threadId.length > 0);
  }

  async save(args = {}, signal) {
    // home 必须是函数级：闸、override 日志、fold-empty 日志、preflight 诊断都在不同块里用它。
    // 2026-10-30 实测：它原先声明在闸的 try 块里，出块即 ReferenceError，
    // 于是 save 成功、preflight 却报 "home is not defined"。
    const home = continuityHome();
    // 预检要用的会话事件：闸在 try 块里读到，但出了块就没了，所以在这里留一份引用。
    let saveEvents = null;
    let saveState = null;
    // 闸里算出来的折叠区间；机械分段要用（块外拿不到 try 里的 const）。
    let saveRange = null;
    // 机械分段的结果：要折成哪几段。在闸之前算好，闸门只检查这些块。
    let planSegments = null;
    const skippedTags = [];
    // 同一条线在这一轮里被推迟的块数（交错时一次只折最早一块）。
    let deferredBlocks = 0;
    // 0.8.6：surface 起点之前的未折区间。只报告，不自动补。
    let skippedRange = null;
    // split:true —— 只出计划，不执行。
    // 为什么不能在这里循环保存：pending 只有一个槽（threads-core:468），
    // 同一个 step 里的多次 save 会互相覆盖，只有最后一段能提交。
    // 正确做法：拿到计划后，逐段跨 step 调用 save（每段一个 tool 调用）。
    if (args?.split === true && (args.fromSeq === undefined || args.fromSeq === null)) {
      const plan = await this.planSplit();
      if (plan.length === 0) throw new Error('continuity.save: split 没有可切的区间（可能已经没有未保存内容）');
      return {
        ok: true,
        split: 'plan-only',
        note: '这不是保存结果。计划共 ' + plan.length + ' 段；pending 只有一个槽，必须逐段跨 step 调用 save（fromSeq/toSeq/threadId）。',
        plan,
      };
    }

    const backfillRequested = args.backfill === true;
    const label = backfillRequested ? (optionalString(args.label) ?? '') : requireString(args.label, 'save.label');
    const why = backfillRequested
      ? (optionalString(args.why) ?? `历史回补 ${String(args.fromSeq ?? '?')}..${String(args.toSeq ?? '?')}`)
      : requireString(args.why, 'save.why');
    const next = backfillRequested
      ? (optionalString(args.next) ?? '检查这段原话')
      : requireString(args.next, 'save.next');
    const residue = optionalString(args.residue);
    const threadId = optionalString(args.threadId);
    // exclude：折「不属于这条线头」的所有块。load 切换前用它——等于"不折我要去的那条"。
    const exclude = optionalString(args.exclude);
    const alias = optionalString(args.alias);
    const relabel = args.relabel === true;
    const fromSeq = args.fromSeq === undefined || args.fromSeq === null ? undefined : Number(args.fromSeq);
    const toSeq = args.toSeq === undefined || args.toSeq === null ? undefined : Number(args.toSeq);
    if (fromSeq !== undefined && !Number.isInteger(fromSeq)) throw new Error('continuity.save: fromSeq must be an integer surface seq');
    if (toSeq !== undefined && !Number.isInteger(toSeq)) throw new Error('continuity.save: toSeq must be an integer surface seq');
    if ((fromSeq !== undefined && toSeq === undefined) || (fromSeq === undefined && toSeq !== undefined)) {
      throw new Error('continuity.save: pass both fromSeq and toSeq, or neither');
    }
    if (backfillRequested) {
      if (fromSeq === undefined || toSeq === undefined) {
        throw new Error('continuity.save: backfill needs explicit fromSeq and toSeq');
      }
      return this.saveBackfill({ fromSeq, toSeq, threadId, label, why, next, residue });
    }
    if (this.backend === null || this.backend === undefined || typeof this.backend.prepareSave !== 'function') {
      throw new Error('continuity.save: the Continuity compaction engine is not mounted');
    }
    const saveArgs = { label, why, next, residue, fromSeq, toSeq, threadId, alias, relabel };
    // 单测用：假 session 没有 turn/事件，四道闸会把夹具判成“缺口”。
    // 只允许测试进程关掉（不是环境变量，避免生产被误静默）。
    if (gatesEnabled) {
    // T0 闸：即将折叠的区间里若还有未决消息，拒绝保存（放 t0-override.json 可带债通过）。
    try {
      const overrideFile = join(home, 't0-override.json');
      // override 必须写明“放行哪些闸 + 为什么”。空文件不再等于全部放行——
      // 踩过：一个残留的空 t0-override.json 静默跳过了四道闸，52 轮没标签也存进去了。
      let override = null;
      try {
        const doc = JSON.parse(readFileSync(overrideFile, 'utf8'));
        const gates = Array.isArray(doc?.gates) ? doc.gates.map(String) : [];
        const reason = String(doc?.reason ?? '').trim();
        if (gates.length > 0 && reason.length >= 4) override = { gates: new Set(gates), reason };
      } catch { override = null; }
      const gatesOpen = (gate) => override !== null && (override.gates.has('all') || override.gates.has(gate));
      const state = await getSession(this.sessionId);
      saveState = state;
      const activeThread = (state.threads ?? []).find((thread) => String(thread.id) === String(state.activeId));
      // 折叠起点 = **当前活跃上下文里**还没被折过的第一条。
      // 不是“活跃线头末段+1”（T2 停了一天，会从 20053 起把昨天全拉进来），
      // 也不是“全局最大覆盖+1”（那会把已折叠之外的空洞一起卷进来）。
      // 判据来源：session.surface.nodes 就是此刻在上下文里的那些 seq。
      const lastToOf = (thread) => Number(thread?.segments?.at(-1)?.toSeq ?? 0);
      const coveredTo = Math.max(0, ...(state.threads ?? []).map(lastToOf));
      const surfaceSeqs = [...(this.agent?.session?.surface?.nodes ?? [])]
        .map((seq) => Number(seq))
        .filter((seq) => Number.isInteger(seq));
      const surfaceTail = surfaceSeqs.filter((seq) => seq > coveredTo).sort((a, b) => a - b);
      const lastTo = coveredTo > 0 ? coveredTo : lastToOf(activeThread);
      // 0.8.6：起点仍是 surface[0]；显式 fromSeq 低于 surface 时落到 surface[0]，
      // 不抛 “not a surface node”。真正的 surface 外补洞走 0.8.7 backfill。
      const surfaceFirst = surfaceTail.length > 0 ? surfaceTail[0] : lastTo + 1;
      const resolved = resolveSaveStart({ explicitFrom: fromSeq, surfaceFirst });
      const startFrom = resolved.startFrom;
      const snapshot = await this.sessionQuery.readSession(this.agent.session.id);
      // readTags() 返回的是包装对象 { state, missing, corrupt }，闸要的是 state 本体。
      // 直接传包装对象等于传了一份空文档：overrides/runs 从来没进过闸（2026-10-30 抓到）。
      const tagsRead = await readTags();
      if (tagsRead.corrupt || tagsRead.missing) {
        recordError(
          `continuity: tags.json ${tagsRead.corrupt ? 'corrupt' : 'missing'}; 闸按“无标签”处理${tagsRead.error ? ` (${tagsRead.error})` : ''}`,
          'tags-read',
        );
      }
      const tagsDoc = tagsRead?.state ?? null;
      let decisions = [];
      try {
        decisions = readFileSync(join(home, 't0-decisions.jsonl'), 'utf8')
          .split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      } catch { decisions = []; }
      // 只算“已经结束的轮次”：当前这一轮还没到判定的时候，不能算未决。
      const allEvents = Array.isArray(snapshot?.events) ? snapshot.events : [];
      saveEvents = allEvents;
      skippedRange = detectSkippedRange({ coveredTo, surfaceFirst, events: allEvents });
      if (skippedRange !== null) {
        recordError(
          `continuity.save: 未折 ${skippedRange.from}..${skippedRange.to}（${skippedRange.events} 条内容事件，surface 起点 ${surfaceFirst}）`,
          'save-hole',
        );
      }
      let maxTurn = -Infinity;
      for (const event of allEvents) {
        const turn = Number(event?.data?.turn);
        if (Number.isInteger(turn) && turn > maxTurn) maxTurn = turn;
      }
      // 折叠右界：显式 toSeq 优先，否则取“最后一个已结束轮”的边界。
      // 这里原写成 `let toSeq = Infinity`，把外层显式 toSeq 遮蔽了——
      // 实测：明确给 42426..43040，却多折了 43444..43670（2026-10-30 定向验证抓到）。
      let boundaryTo = Infinity;
      if (Number.isFinite(maxTurn)) {
        let boundary = -Infinity;
        for (const event of allEvents) {
          const turn = Number(event?.data?.turn);
          if (!Number.isInteger(turn) || turn >= maxTurn) continue;
          const seq = Number(event?.seq);
          if (Number.isInteger(seq) && seq > boundary) boundary = seq;
        }
        if (Number.isFinite(boundary)) boundaryTo = boundary;
      }
      const cutTo = toSeq !== undefined ? toSeq : boundaryTo;
      // 逐轮标签必须在使用前读进来：之前写成“先用后声明”，ReferenceError 被下面的
      // catch 吞掉，四道闸全部静默失效（2026-10-29 反向验收抓到：90 轮无标签也存了）。
      let turnTagRows = [];
      try {
        turnTagRows = readFileSync(join(home, 'turn-tags.jsonl'), 'utf8').split('\n').filter(Boolean)
          .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      } catch { turnTagRows = []; }

      // ---- 先算“真正要折哪几块”，再跑闸 ----
      // 以前闸门按“活跃线头末段+1 → 缓冲区末”检查，exclude 模式会把整条线拉进来，
      // 于是几百条从没判过的历史把 save 拦死（实测：598 条未决）。闸门该看的是要折的块。
      const tagOf = new Map();
      for (const row of turnTagRows) tagOf.set(Number(row.turn), String(row.tag));
      // user/message 没有 data.turn（结构性事实）：先归轮，再切块——**两个分支都要用**。
      // 不归轮的话块会从 assistant 开始，用户原话永远折不进去，下次 save 又看见它。
      // （2026-10-30 踩过：把这段放在 exclude 分支里，else 分支直接 ReferenceError。）
      const orderedForRuns = (Array.isArray(allEvents) ? allEvents : [])
        .map((event) => ({
          seq: Number(event?.seq),
          type: event?.type,
          turn: Number.isInteger(Number(event?.data?.turn)) ? Number(event.data.turn) : null,
        }))
        .filter((event) => Number.isInteger(event.seq));
      const attributedTurns = attributeTurnSeqs(orderedForRuns);
      const turnBySeq = new Map();
      for (const [turn, seqs] of attributedTurns.turnSeqs) for (const seq of seqs) turnBySeq.set(Number(seq), turn);
      const eventsForRuns = orderedForRuns.map((event) => ({ seq: event.seq, type: event.type, turn: event.turn ?? turnBySeq.get(event.seq) ?? null }));
      if (exclude !== undefined) {
        const known = new Map();
        for (const thread of saveState?.threads ?? []) {
          known.set(String(thread.id), String(thread.id));
          if (typeof thread.alias === 'string' && thread.alias.length > 0) known.set(thread.alias, String(thread.id));
        }
        const excludeId = known.get(exclude) ?? exclude;
        planSegments = [];
        const seenThreads = new Set();
        let deferred = 0;
        for (const block of blocksByTag({ events: eventsForRuns, tagOf, fromSeq: startFrom, toSeq: cutTo })) {
          if (block.tag === excludeId) continue;
          const resolved = known.get(block.tag) ?? null;
          if (resolved === null) { skippedTags.push(block.tag); continue; }
          // 同一条线在一次 save 里只折最早的那一块：同时追加两段会让第二段的前驱算错。
          // 交错块留给下一次 save（机制上仍成立，只是需要多存几次）。
          if (seenThreads.has(resolved)) { deferred += 1; continue; }
          seenThreads.add(resolved);
          planSegments.push({ fromSeq: block.fromSeq, toSeq: block.toSeq, threadId: resolved });
        }
        if (deferred > 0) deferredBlocks = deferred;
      } else {
        const target = String(threadId ?? saveState?.activeId ?? '');
        planSegments = runsForThread({ events: eventsForRuns, tagOf, fromSeq: startFrom, toSeq: cutTo, target })
          .map((run) => ({ fromSeq: run.fromSeq, toSeq: run.toSeq, threadId: target }));
      }
      // 闸门区间 = 要折的块并集；没有块时才退回整段。
      const gateFrom = planSegments.length > 0 ? Math.min(...planSegments.map((part) => part.fromSeq)) : startFrom;
      const gateTo = planSegments.length > 0 ? Math.max(...planSegments.map((part) => part.toSeq)) : cutTo;
      saveRange = { fromSeq: gateFrom, toSeq: gateTo };

      const gateResult = contentUndecided({
        events: allEvents,
        tagsDoc,
        decisions,
        turnTagRows,
        fromSeq: gateFrom,
        toSeq: gateTo,
      });
      if (!gatesOpen('t0-undecided') && gateResult.undecided.length > 0) {
        const sample = gateResult.undecided.slice(0, 5).map((row) => row.seq + ' ' + row.head).join(' | ');
        const error = new Error('continuity.save: 拒绝保存——即将折叠的区间还有 ' + gateResult.undecided.length
          + ' 条未决（没人判过归属）。先跑 t0decide.mjs queue --from ' + startFrom + ' 逐条 decide；'
          + '要带债保存，放 ' + overrideFile + '。示例：' + sample);
        error.code = 't0-undecided';
        throw error;
      }
      // 全局轮标签闸：已结束的轮缺口过大 → 不是“还没轮到”，是机制漏打；此时折叠等于把缺口压成灰。
      let maxTurnAll = 0;
      for (const event of allEvents) {
        const turn = Number(event?.data?.turn);
        if (Number.isInteger(turn) && turn > maxTurnAll) maxTurnAll = turn;
      }
      const globalGap = turnTagGap({ events: allEvents, turnTagRows, boundaryTurn: maxTurnAll - 1 });
      if (!gatesOpen('tags-gap') && globalGap.missing.length > 0) {
        const sample = globalGap.missing.slice(0, 6).map((row) => 'turn ' + row.turn).join(', ');
        const advice = globalGap.missing.length > 20 ? '缺口过大：node tag-gap.mjs 出清单 → 逐轮补判' : '逐轮补判：node turnmap.mjs set --turn <轮> --tag Tx（新事物用 --new）';
        const error = new Error('continuity.save: 拒绝保存——已结束的轮里有 ' + globalGap.missing.length
          + ' 轮没有标签（' + globalGap.tagged + '/' + globalGap.settled + ' 已判）。示例：' + sample
          + '。' + advice + '；要带债保存，放 ' + overrideFile + '。');
        error.code = 'tags-gap';
        throw error;
      }
      // 区间已被别的线头的段覆盖 → 不要重复存（会造出同名不同义的重复段）。
      // 这通常发生在“active 线头的边界落后于全局水位”时。
      const coveredAll = [];
      for (const thread of state.threads ?? []) {
        for (const seg of thread.segments ?? []) coveredAll.push([Number(seg.fromSeq), Number(seg.toSeq)]);
      }
      const uncoveredInRange = allEvents.filter((event) => {
        if (event?.type !== 'user/message' && event?.type !== 'assistant/message') return false;
        const seq = Number(event?.seq);
        if (!Number.isInteger(seq) || seq < startFrom || seq > cutTo) return false;
        return !coveredAll.some(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && seq >= a && seq <= b);
      }).length;
      if (!gatesOpen('range-covered') && uncoveredInRange === 0) {
        const error = new Error('continuity.save: 区间 ' + startFrom + '..' + cutTo
          + ' 已被其他线头的段覆盖，没有新内容可存（active 线头边界落后于全局水位）。用 save split:true 按话题切，或先 load 到正确的线头。');
        error.code = 'range-already-covered';
        throw error;
      }
      const untagged = untaggedTurnList({ events: allEvents, turnTagRows, fromSeq: startFrom, toSeq: cutTo });
      if (!gatesOpen('turn-untagged') && untagged.length > 0) {
        const sample = untagged.slice(0, 5).map((row) => 'turn ' + row.turn + ' (seq ' + row.seq + ')').join(', ');
        const error = new Error('continuity.save: 拒绝保存——这次折叠覆盖的轮里有 ' + untagged.length
          + ' 轮没有标签。先用 turnmap.mjs set --turn N --tag Tx 补上；示例：' + sample
          + '；要带债保存，放 ' + overrideFile + '。');
        error.code = 'turn-untagged';
        throw error;
      }
      // C7 闸：即将折叠的区间里有“死胡同症状”（同处改多版 / 改完仍同错 / 改动无判据）→ 拒绝。
      const c7Calls = [];
      const c7Errors = [];
      const c7Replies = [];
      for (const event of allEvents) {
        const seq = Number(event?.seq);
        if (!Number.isInteger(seq) || seq < startFrom || seq > cutTo) continue;
        const turn = Number(event?.data?.turn);
        const turnValue = Number.isInteger(turn) ? turn : 0;
        if (event?.type === 'tool/call') {
          const path = pathFromArguments(event?.data?.name, event?.data?.arguments);
          c7Calls.push({ turn: turnValue, path });
        } else if (event?.type === 'tool/result') {
          const text = JSON.stringify(event?.data ?? '');
          if (/"(isError|error)"\s*:\s*true|Error:|失败|failed/i.test(text)) {
            c7Errors.push({ turn: turnValue, sig: text.replace(/\s+/g, ' ').slice(0, 60) });
          }
        } else if (event?.type === 'assistant/message') {
          let replyText = '';
          try { replyText = eventText(event, { includeReasoning: false }).trim(); } catch { replyText = ''; }
          if (replyText.length > 0) c7Replies.push({ turn: turnValue, text: replyText });
        }
      }
      // 只看区间的“尾部 12 轮”：死胡同是“正在发生”的症状，不是历史统计。
      let c7MaxTurn = 0;
      for (const row of c7Calls) if (row.turn > c7MaxTurn) c7MaxTurn = row.turn;
      for (const row of c7Errors) if (row.turn > c7MaxTurn) c7MaxTurn = row.turn;
      const c7 = detectDeadEnds({
        toolCalls: c7Calls.filter((row) => row.turn > c7MaxTurn - 12),
        errors: c7Errors.filter((row) => row.turn > c7MaxTurn - 12),
        replies: c7Replies.slice(-2),
        windowTurns: 12,
        limit: 3,
      });
      if (!gatesOpen('deadend-symptoms') && c7.symptoms.length > 0) {
        const error = new Error('continuity.save: 拒绝保存——这次折叠的区间里有死胡同症状：' + c7.symptoms.join('；')
          + '。先补判据或换地方改（同处改三版就该停下来搜文献）；要带债保存，放 ' + overrideFile + '。');
        error.code = 'deadend-symptoms';
        throw error;
      }
      if (override !== null) {
        try {
          appendFileSync(join(home, 'override-log.jsonl'), JSON.stringify({
            at: new Date().toISOString(),
            gates: [...override.gates],
            reason: override.reason,
          }) + '\n');
        } catch { /* 日志失败不阻断保存 */ }
        try { unlinkSync(overrideFile); } catch { /* 删不掉下次还会放行 */ }
      }
    } catch (error) {
      if (error?.code === 't0-undecided' || error?.code === 'turn-untagged' || error?.code === 'deadend-symptoms' || error?.code === 'tags-gap' || error?.code === 'range-already-covered') throw error;
      // 闸自身出错不阻断保存（宁可漏闸，不可卡死）——但必须留痕：
      // 一个 ReferenceError 曾在这里被静默吞掉，四道闸一起失效。
      try {
        appendFileSync(join(continuityHome(), 'gate-errors.jsonl'), JSON.stringify({
          at: new Date().toISOString(),
          name: String(error?.name ?? 'Error'),
          code: error?.code ?? null,
          message: String(error?.message ?? error).slice(0, 300),
        }) + '\n');
      } catch { /* 日志都写不了就算了，但不能因此阻断 */ }
      // 闸自身写错（ReferenceError/TypeError）时静默放行，等于四道闸一起失效——
      // 今天已经这样漏过两次（20 轮、97 轮无标签被折叠）。改成响亮地中止。
      if (error?.name === 'ReferenceError' || error?.name === 'TypeError') {
        const fatal = new Error('continuity.save: 闸自身出错（' + error.name + ': ' + error.message
          + '），已中止保存——不静默放行。详情见 gate-errors.jsonl。');
        fatal.code = 'gate-error';
        throw fatal;
      }
    }
    }

    // 机械分段已在闸门之前算好（planSegments / skippedTags），这里只执行结果：
    //   exclude=<线头>：折所有**不属于它**的块（load 切换前用）
    //   否则：只折属于目标线头的块
    // planSegments === null 表示没走到闸（单测关闸、或拿不到 session）→ 走旧路径整段存。
    const skippedNote = skippedRange === null
      ? ''
      : `\n⚠ 未折 ${skippedRange.from}..${skippedRange.to}（${skippedRange.events} 条内容事件，surface 起点之前）——要补：save({fromSeq:${skippedRange.from},toSeq:${skippedRange.to},backfill:true})`;
    if (planSegments !== null && planSegments.length === 0) {
      // 不许静默：折 0 段也留一行痕迹，否则“该折没折”在屏幕上看不见（踩过：autoSave 空转）。
      try {
        appendFileSync(join(home, 'fold-empty.log'), JSON.stringify({
          at: new Date().toISOString(),
          fromSeq: saveRange?.fromSeq ?? null,
          toSeq: saveRange?.toSeq ?? null,
          threads: threadId ?? null,
        }) + '\n');
      } catch { /* 日志失败不阻断 */ }
      return {
        ok: true,
        pending: false,
        folded: 0,
        skipped: skippedTags,
        skippedRange,
        receipt: `没有折叠：seq ${saveRange?.fromSeq ?? '?'}..${saveRange?.toSeq ?? '?'} 没有需要折的块${skippedNote}`,
        hint: '要折当前线头本身就别传 exclude；或显式给 fromSeq/toSeq。',
      };
    }
    if (planSegments !== null && planSegments.length > 1) {
      const items = [];
      for (const part of planSegments) {
        const partArgs = { ...saveArgs, fromSeq: part.fromSeq, toSeq: part.toSeq, threadId: part.threadId };
        const preparedPart = await this.backend.prepareSave(this.agent, partArgs);
        items.push({
          mode: preparedPart?.mode === 'append' ? 'append' : 'new',
          args: partArgs,
          prepared: preparedPart,
          thread: preparedPart?.thread,
        });
      }
      await updateSession(this.sessionId, (current) => {
        current.pending = { kind: 'save', items };
        return current;
      });
      return {
        ok: true,
        pending: true,
        split: items.length,
        skipped: skippedTags,
        skippedRange,
        deferred: deferredBlocks,
        receipt: `按标签折成 ${items.length} 段：` + items.map((item) => `${item.thread?.id ?? item.args?.threadId ?? '?'} seq ${item.prepared?.segment?.fromSeq ?? '?'}..${item.prepared?.segment?.toSeq ?? '?'}`).join(' · ')
          + (deferredBlocks > 0 ? `（另有 ${deferredBlocks} 块交错，留给下一次 save）` : '')
          + skippedNote,
      };
    }
    if (planSegments !== null && planSegments.length === 1) {
      saveArgs.fromSeq = planSegments[0].fromSeq;
      saveArgs.toSeq = planSegments[0].toSeq;
      saveArgs.threadId = planSegments[0].threadId;
    }

    const prepared = await this.backend.prepareSave(this.agent, saveArgs);
    const thread = prepared?.thread;
    if (thread === undefined || thread === null) throw new Error('continuity.save: no thread range was prepared');
    const mode = prepared.mode === 'append' ? 'append' : 'new';
    const segments = Array.isArray(thread.segments) && thread.segments.length > 0
      ? thread.segments
      : [thread];
    const segment = prepared.segment ?? segments[segments.length - 1] ?? thread;
    const segmentIndex = Number.isFinite(prepared.segmentIndex)
      ? prepared.segmentIndex
      : Math.max(1, segments.length);
    const tokenCount = Number(segment.tokens ?? thread.tokens) || 0;
    let receipt = mode === 'append'
      ? `saved into ${thread.id} · segment ${segmentIndex} · seq ${segment.fromSeq}..${segment.toSeq} · ${formatTokenCount(tokenCount)} tokens`
      : `saved as ${thread.id} · seq ${segment.fromSeq}..${segment.toSeq} · ${formatTokenCount(tokenCount)} tokens`;
    receipt += skippedNote;

    // The durable gist is committed at the next pre-step, after this tool
    // result is appended. Appending it here would put a user message between
    // the assistant tool-call and its result and break request pairing.
    await updateSession(this.sessionId, (current) => {
      if (mode === 'append') {
        current.threads = current.threads.map((entry) => ({
          ...entry,
          active: entry.id === thread.id,
        }));
        current.activeId = thread.id;
      } else {
        for (const entry of current.threads) entry.active = false;
        current.activeId = null;
      }
      current.pending = { kind: 'save', mode, args: saveArgs, prepared, thread };
      return current;
    });
    // 预检：把“每次 save 前要手查的几件事”一次算好，附在回执里。
    let preflight = null;
    let health = null;
    let preflightError = null;
    let tagRowsForDiag = null;
    try {
      const rows = (() => {
        try {
          return readFileSync(join(home, 'turn-tags.jsonl'), 'utf8').split('\n').filter(Boolean)
            .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
        } catch { return []; }
      })();
      tagRowsForDiag = { home, rows: rows.length };
      // 不带 fromSeq/toSeq 的 save 也要有区间：优先用刚落的这一段，
      // 这样 preflight 计划与实际 segment 同源（0.8.6 R3）。
      const rangeFrom = Number(prepared?.segment?.fromSeq ?? fromSeq ?? 0);
      const rangeTo = Number(prepared?.segment?.toSeq ?? toSeq ?? 0);
      preflight = buildPreflight({ events: saveEvents ?? [], turnTagRows: rows, fromSeq: rangeFrom, toSeq: rangeTo });
      let projection = null;
      try { projection = JSON.parse(readFileSync(join(home, 'projection-state.json'), 'utf8')); } catch { projection = null; }
      const sessionThreads = Array.isArray(saveState?.threads) ? saveState.threads : [];
      health = summarizeHealth({ events: saveEvents ?? [], threads: sessionThreads, projection });
    } catch (error) {
      // 不许吞：把错误本身带回回执，下一次 save 一眼能看到原因。
      preflight = null;
      health = null;
      preflightError = String(error?.name ?? 'Error') + ': ' + String(error?.message ?? error);
    }

    const planFrom = Number(preflight?.plan?.[0]?.from);
    const planNote = Number.isFinite(planFrom) && Number.isFinite(Number(segment.fromSeq))
      && planFrom !== Number(segment.fromSeq)
      ? `preflight plan[0].from=${planFrom}，segment.fromSeq=${segment.fromSeq}；计划只计有轮归属的内容事件`
      : null;
    if (planNote !== null) receipt += '\n(' + planNote + ')';

    return {
      ok: true,
      pending: true,
      mode,
      receipt,
      id: thread.id,
      segment: segmentIndex,
      segments: segments.length,
      active: thread.active !== false,
      span: `${segment.spanStart} → ${segment.spanEnd}`,
      tokens: tokenCount,
      seqStart: segment.fromSeq,
      seqEnd: segment.toSeq,
      count: segment.count,
      adjusted: Boolean(prepared.adjusted),
      skippedRange,
      planNote,
      preflight,
      health,
      preflightError,
      // 诊断：preflight 说“无标签”时，用它一眼判断是文件没读到、还是标签真没有。
      tagRows: tagRowsForDiag,
    };
  }

  /**
   * 0.8.9 historical backfill: append an archival segment from raw snapshot
   * events. It never calls selectSaveRange and never touches the live surface.
   */
  async saveBackfill({ fromSeq, toSeq, threadId, why, next, residue }) {
    const home = continuityHome();
    const state = await getSession(this.sessionId);
    let target = null;
    if (threadId !== undefined) {
      target = state.threads.find((thread) => String(thread.id) === String(threadId))
        ?? state.threads.find((thread) => String(thread.alias ?? '') === String(threadId))
        ?? null;
      if (target === null) throw new Error(`continuity.save: unknown threadId ${threadId}`);
    } else {
      target = state.threads.find((thread) => String(thread.id) === String(state.activeId)) ?? null;
      if (target === null) throw new Error('continuity.save: backfill needs an existing threadId or active thread');
    }

    const allSegments = state.threads.flatMap((thread) => thread.segments ?? []);
    if (rangeOverlaps(allSegments, fromSeq, toSeq)) {
      const error = new Error(`continuity.save: range ${fromSeq}..${toSeq} overlaps an existing segment; backfill is append-only`);
      error.code = 'range-already-covered';
      throw error;
    }

    const snapshot = await this.sessionQuery.readSession(this.agent.session.id);
    const allEvents = Array.isArray(snapshot?.events) ? snapshot.events : [];
    const selected = trimBackfillEvents(selectBackfillEvents(allEvents, fromSeq, toSeq));
    if (selected.length === 0) {
      const error = new Error(`continuity.save: backfill ${fromSeq}..${toSeq} contains no content events`);
      error.code = 'backfill-empty';
      throw error;
    }

    let turnTagRows = [];
    try {
      turnTagRows = readFileSync(join(home, 'turn-tags.jsonl'), 'utf8').split('\n').filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    } catch { turnTagRows = []; }
    let decisions = [];
    try {
      decisions = readFileSync(join(home, 't0-decisions.jsonl'), 'utf8').split('\n').filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    } catch { decisions = []; }
    let tagsDoc = null;
    try {
      const tagsRead = await readTags();
      tagsDoc = tagsRead?.state ?? null;
    } catch { tagsDoc = null; }

    const undecided = contentUndecided({
      events: allEvents,
      tagsDoc,
      decisions,
      turnTagRows,
      fromSeq,
      toSeq,
    });
    if (undecided.undecided.length > 0) {
      const sample = undecided.undecided.slice(0, 5).map((row) => row.seq + ' ' + row.head).join(' | ');
      const error = new Error(`continuity.save: backfill rejected — ${undecided.undecided.length} undecided content events; decide them first. Sample: ${sample}`);
      error.code = 't0-undecided';
      throw error;
    }
    const untagged = untaggedTurnList({ events: allEvents, turnTagRows, fromSeq, toSeq });
    if (untagged.length > 0) {
      const sample = untagged.slice(0, 5).map((row) => `turn ${row.turn} (seq ${row.seq})`).join(', ');
      const error = new Error(`continuity.save: backfill rejected — untagged turns in range: ${sample}`);
      error.code = 'turn-untagged';
      throw error;
    }
    let maxTurn = 0;
    for (const event of allEvents) {
      const turn = Number(event?.data?.turn);
      if (Number.isInteger(turn) && turn > maxTurn) maxTurn = turn;
    }
    const gap = turnTagGap({ events: allEvents, turnTagRows, boundaryTurn: maxTurn - 1 });
    if (gap.missing.length > 0) {
      const sample = gap.missing.slice(0, 6).map((row) => 'turn ' + row.turn).join(', ');
      const error = new Error(`continuity.save: backfill rejected — ${gap.missing.length} settled turns missing tags: ${sample}`);
      error.code = 'tags-gap';
      throw error;
    }

    const tCoverage = tagsDoc === null
      ? TAG_ZERO
      : tagCoverageForRange(tagsDoc, Number(selected[0].seq), Number(selected[selected.length - 1].seq), { threads: state.threads }).label;
    const segment = buildBackfillSegment(selected, {
      sessionId: this.agent.session.id,
      why: typeof why === 'string' && why.trim().length > 0 ? why.trim() : `历史回补 ${fromSeq}..${toSeq}`,
      next: typeof next === 'string' && next.trim().length > 0 ? next.trim() : '检查这段原话',
      residue,
      tCoverage,
    });
    const mergedSegments = [...(target.segments ?? []), segment]
      .sort((left, right) => Number(left.fromSeq) - Number(right.fromSeq));
    const segmentIndex = mergedSegments.findIndex((entry) => entry === segment) + 1;
    const latestContent = mergedSegments[mergedSegments.length - 1];
    const contentUpdatedAt = latestContent?.spanEnd ?? latestContent?.at ?? new Date().toISOString();
    await updateSession(this.sessionId, (current) => {
      current.threads = current.threads.map((thread) => {
        if (String(thread.id) !== String(target.id)) return { ...thread, active: false };
        return { ...thread, segments: mergedSegments, active: true, updatedAt: contentUpdatedAt };
      });
      current.activeId = target.id;
      return current;
    });

    return {
      ok: true,
      pending: false,
      mode: 'backfill',
      surfaceTouched: false,
      adjusted: false,
      receipt: `backfilled into ${target.id} · segment ${segmentIndex} · seq ${segment.fromSeq}..${segment.toSeq} · ${formatTokenCount(segment.tokens)} tokens（归档段，不是当轮折叠）`,
      id: target.id,
      segment: segmentIndex,
      segments: mergedSegments.length,
      active: true,
      span: `${segment.spanStart} → ${segment.spanEnd}`,
      tokens: segment.tokens,
      seqStart: segment.fromSeq,
      seqEnd: segment.toSeq,
      count: segment.count,
      requestedRange: { from: fromSeq, to: toSeq },
      seqs: segment.seqs,
    };
  }

  async load(args = {}, signal) {
    let id = optionalString(args.id);
    const seqs = integerList(args.seqs, 'load.seqs');
    if (id === undefined && seqs === undefined) {
      throw new Error('continuity.load: id or seqs is required');
    }
    let threads = [];
    if (id !== undefined) {
      try {
        threads = (await getSession(this.sessionId)).threads;
      } catch {
        threads = [];
      }
      id = canonicalTagId(id, threads);
      const read = await readTagsMigrated(threads);
      if (read.migration.changed) await this.writeTagsMarkdown(read.state);
    }
    // T0 是未分类桶，不是线头：没有关键词、没有主题、无法“拿起”。
    // 看未分类内容请用 scan/find；要先归位到具体 T 或新建 T，再 load。
    if (id === 'T0') {
      return {
        ok: false,
        reason: 't0-is-bucket',
        id,
        injected: 0,
        tokens: 0,
        active: false,
        hint: 'T0 是未分类桶，不能 load。用 scan/find 查看，或先 tag 归位到具体 T。',
      };
    }
    const budget = budgetOf(args.budgetTokens);
    const withReasoning = args.withReasoning === true;
    const fromSeq = optionalInteger(args.fromSeq, 'load.fromSeq');
    const toSeq = optionalInteger(args.toSeq, 'load.toSeq');
    const select = integerList(args.select, 'load.select');
    const first = optionalInteger(args.first, 'load.first');
    const last = optionalInteger(args.last, 'load.last');
    if ((first !== undefined && first < 0) || (last !== undefined && last < 0)) {
      throw new Error('continuity.load: first/last must be >= 0');
    }
    if (first === 0 && last === 0) throw new Error('continuity.load: first and last cannot both be 0');
    if (first !== undefined || last !== undefined) {
      if (seqs !== undefined || fromSeq !== undefined || select !== undefined) {
        throw new Error('continuity.load: first/last are only valid for a tag id');
      }
    }
    if ((fromSeq === undefined) !== (toSeq === undefined)) {
      throw new Error('continuity.load: pass both fromSeq and toSeq, or neither');
    }
    if (fromSeq !== undefined && fromSeq > toSeq) {
      throw new Error('continuity.load: fromSeq must be <= toSeq');
    }
    if (seqs !== undefined) {
      if (fromSeq !== undefined || select !== undefined) {
        throw new Error('continuity.load: use seqs or fromSeq/toSeq/select, not both');
      }
      return this.loadSeqs({ id, seqs, budget, withReasoning }, signal);
    }
    const state = await getSession(this.sessionId);
    const thread = state.threads.find((entry) => entry.id === id);
    if (thread !== undefined) {
      if (first !== undefined || last !== undefined) {
        throw new Error('continuity.load: first/last are only valid for a tag id');
      }
      return this.loadThread({ id, thread, fromSeq, toSeq, select, budget, withReasoning }, signal);
    }
    if (fromSeq !== undefined || select !== undefined) {
      throw new Error('continuity.load: fromSeq/toSeq/select are only valid for a thread id; use seqs for a tag');
    }
    return this.loadTag({ id, budget, first, last, withReasoning }, signal);
  }

  /** Old thread load path: latest segment, range, or exact select; sets active. */
  async loadThread({ id, thread, fromSeq, toSeq, select, budget, withReasoning = false }, signal) {
    if (select !== undefined && fromSeq !== undefined) {
      const outside = select.filter((seq) => seq < fromSeq || seq > toSeq);
      if (outside.length > 0) {
        return {
          ok: false,
          reason: 'select-outside-range',
          id,
          seqs: outside,
          injected: 0,
          tokens: 0,
          active: false,
        };
      }
    }
    signal?.throwIfAborted?.();

    let snapshot;
    try {
      snapshot = await this.sessionQuery.readSession(this.agent.session.id);
    } catch (error) {
      recordError(error?.message ?? String(error), 'thread-load');
      snapshot = null;
    }
    const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
    const bySeq = new Map(events.map((event) => [Number(event.seq), event]));
    const threadSegments = Array.isArray(thread.segments) && thread.segments.length > 0
      ? thread.segments
      : [];
    const latest = threadSegments[threadSegments.length - 1] ?? thread;
    const segmentIndex = Math.max(1, threadSegments.length);
    const segmentCount = Math.max(1, threadSegments.length);
    const threadSeqs = new Set(threadSegments.flatMap((segment) => (
      Array.isArray(segment.seqs) ? segment.seqs.map(Number) : []
    )));
    if (threadSeqs.size === 0) {
      for (const seq of latest.seqs ?? []) threadSeqs.add(Number(seq));
    }

    let selected = [];
    let range = null;
    if (select !== undefined) {
      const notInThread = select.filter((seq) => !threadSeqs.has(seq));
      if (notInThread.length > 0) {
        return {
          ok: false,
          reason: 'seq-not-in-thread',
          id,
          seqs: notInThread,
          injected: 0,
          tokens: 0,
          active: false,
        };
      }
      const missingSeq = select.filter((seq) => !bySeq.has(seq));
      if (missingSeq.length > 0) {
        return {
          ok: false,
          reason: 'unknown-seq',
          id,
          seqs: missingSeq,
          injected: 0,
          tokens: 0,
          active: false,
        };
      }
      for (const seq of select) {
        const event = bySeq.get(seq);
        const text = quoteEventText(event);
        if (text.length === 0) continue;
        selected.push({ seq, event, role: eventRole(event), text, tokens: estimateTextTokens(text) });
      }
      if (fromSeq !== undefined) range = { fromSeq, toSeq };
    } else if (fromSeq !== undefined) {
      const rangeSeqs = [...threadSeqs]
        .filter((seq) => seq >= fromSeq && seq <= toSeq)
        .sort((left, right) => left - right);
      if (rangeSeqs.length === 0) {
        return {
          ok: false,
          reason: 'empty-range',
          id,
          injected: 0,
          tokens: 0,
          active: false,
          range: { fromSeq, toSeq },
        };
      }
      const result = selectLoadSegment({
        seqs: rangeSeqs,
        bySeq,
        budget: withReasoning ? Number.MAX_SAFE_INTEGER : budget,
      });
      if (result.missing) {
        return {
          ok: false,
          reason: 'raw-missing',
          id,
          injected: 0,
          tokens: 0,
          active: false,
          range: { fromSeq, toSeq },
        };
      }
      selected = result.selected;
      range = { fromSeq, toSeq };
    } else {
      const seqs = Array.isArray(latest.seqs) && latest.seqs.length > 0
        ? latest.seqs
        : [latest.fromSeq ?? thread.seqStart, latest.toSeq ?? thread.seqEnd];
      const result = selectLoadSegment({
        seqs,
        bySeq,
        budget: withReasoning ? Number.MAX_SAFE_INTEGER : budget,
      });
      if (!result.missing) selected = result.selected;
    }

    const picked = selected.length;
    let reasoned = null;
    if (withReasoning) {
      reasoned = applyReasoningBudget({
        selected,
        bySeq,
        budget: REASONING_LOAD_BUDGET,
      });
      selected = reasoned.selected;
    }

    const segs = selected.map((entry) => Number(entry.seq));
    const tokens = withReasoning
      ? reasoned.tokens
      : selected.reduce((sum, entry) => sum + (Number(entry.tokens) || 0), 0);
    const missing = snapshot === null || picked === 0;
    const folds = (await readFolds(this.sessionId)).folds;
    const folded = foldedInfo(folds, selected);
    const note = select !== undefined
      ? `${range === null ? '' : `范围 ${range.fromSeq}..${range.toSeq} · `}选择 ${select.length} 条`
      : range === null ? undefined : `范围 ${range.fromSeq}..${range.toSeq}`;
    const reasoningInfo = withReasoning
      ? { reasoningInjected: reasoned.reasoningInjected, skipped: reasoned.skipped }
      : undefined;
    const text = missing
      ? threadLoadIndexOnly(thread, segmentIndex, segmentCount, note, folded.foldedNote)
      : threadLoadText(
        thread,
        latest,
        withReasoning ? quoteSelectedWithReasoning(selected) : quoteSelected(selected),
        segmentIndex,
        segmentCount,
        note,
        folded.foldedNote,
        reasoningInfo,
      );
    const injected = missing ? 0 : selected.length;
    const outputTokens = missing ? 0 : tokens;
    const outputBudget = withReasoning ? REASONING_LOAD_BUDGET : budget;
    const reasoningFields = withReasoning
      ? {
        reasoningInjected: reasoned.reasoningInjected,
        reasoningTokens: reasoned.reasoningTokens,
        skipped: reasoned.skipped,
      }
      : {};

    await updateSession(this.sessionId, (current) => {
      current.threads = current.threads.map((entry) => ({
        ...entry,
        active: entry.id === id,
      }));
      current.activeId = id;
      current.pending = {
        kind: 'load',
        id,
        text,
        injected,
        tokens: outputTokens,
        rawMissing: missing,
        segment: segmentIndex,
        segments: segmentCount,
        segs,
        folded: folded.folded,
        visible: folded.visible,
        ...(range === null ? {} : { range }),
        ...(select === undefined ? {} : { select }),
        mode: 'thread',
        ...reasoningFields,
      };
      return current;
    });
    if (missing) {
      recordError(`continuity.load: raw missing for thread ${id}; index only`, 'thread-load-raw');
      return {
        ok: false,
        reason: 'raw-missing',
        id,
        mode: 'thread',
        injected: 0,
        tokens: 0,
        active: true,
        pending: true,
        budget: outputBudget,
        segment: segmentIndex,
        segments: segmentCount,
        segs: [],
        folded: [],
        visible: [],
        ...(range === null ? {} : { range }),
        ...(select === undefined ? {} : { select }),
        ...reasoningFields,
      };
    }
    return {
      ok: true,
      pending: true,
      id,
      mode: 'thread',
      injected,
      tokens: outputTokens,
      active: true,
      budget: outputBudget,
      segment: segmentIndex,
      segments: segmentCount,
      segs,
      folded: folded.folded,
      visible: folded.visible,
      ...(range === null ? {} : { range }),
      ...(select === undefined ? {} : { select }),
      ...reasoningFields,
    };
  }

  /** Tag load: find(id), first N + last M (default 3/5), trim only if over budget. */
  async loadTag({ id, budget, first, last, withReasoning = false }, signal) {
    const firstCount = first === undefined ? 3 : first;
    const lastCount = last === undefined ? 5 : last;
    if (firstCount < 0 || lastCount < 0) throw new Error('continuity.load: first/last must be >= 0');
    if (firstCount === 0 && lastCount === 0) throw new Error('continuity.load: first and last cannot both be 0');
    const read = await readTagsWithWarning();
    const tags = read.state;
    signal?.throwIfAborted?.();
    let snapshot;
    try {
      snapshot = await this.sessionQuery.readSession(this.agent.session.id);
    } catch (error) {
      recordError(error?.message ?? String(error), 'tag-load');
      snapshot = null;
    }
    const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
    const found = findTagSeqs({ tags, id, events, limit: null });
    if (found.count === 0) {
      return { ok: false, reason: 'empty-tag', id, mode: 'tag', injected: 0, tokens: 0, active: false, segs: [] };
    }
    const bySeq = new Map(events.map((event) => [Number(event.seq), event]));
    const targetSeqs = [];
    if (firstCount > 0) targetSeqs.push(...found.seqs.slice(0, firstCount));
    if (lastCount > 0) targetSeqs.push(...found.seqs.slice(-lastCount));
    const target = [...new Set(targetSeqs)].sort((left, right) => left - right);
    const selected = [];
    for (const seq of target) {
      const event = bySeq.get(seq);
      if (event === undefined) continue;
      const text = quoteEventText(event);
      if (text.length === 0) continue;
      selected.push({ seq, event, role: eventRole(event), text, tokens: estimateTextTokens(text) });
    }
    const picked = selected.length;
    let reasoned = null;
    let fitted;
    if (withReasoning) {
      reasoned = applyReasoningBudget({
        selected,
        bySeq,
        budget: REASONING_LOAD_BUDGET,
      });
      fitted = reasoned.selected;
    } else {
      fitted = trimSelectedToBudget(selected, budget);
    }
    const segs = fitted.map((entry) => Number(entry.seq));
    const tokens = withReasoning
      ? reasoned.tokens
      : fitted.reduce((sum, entry) => sum + (Number(entry.tokens) || 0), 0);
    const missing = snapshot === null || picked === 0;
    const folds = (await readFolds(this.sessionId)).folds;
    const folded = foldedInfo(folds, fitted);
    let threads = [];
    try {
      threads = (await getSession(this.sessionId)).threads;
    } catch {
      threads = [];
    }
    const tagRow = tagsView(tags, { threads }).tags.find((entry) => entry.id === id);
    const explicitLabel = tags.tags[id]?.label;
    const hasLabel = typeof explicitLabel === 'string' && explicitLabel.length > 0 && explicitLabel !== id;
    const display = tagRow?.display
      ?? (hasLabel ? explicitLabel : (id.length > 8 ? id.slice(0, 8) : id));
    const reasoningFields = withReasoning
      ? {
        reasoningInjected: reasoned.reasoningInjected,
        reasoningTokens: reasoned.reasoningTokens,
        skipped: reasoned.skipped,
      }
      : {};
    const text = selectionLoadText({
      id,
      label: hasLabel ? explicitLabel : null,
      display,
      count: segs.length,
      first: firstCount,
      last: lastCount,
      foldedNote: folded.foldedNote,
      withReasoning,
      reasoningInjected: withReasoning ? reasoned.reasoningInjected : 0,
      skipped: withReasoning ? reasoned.skipped : 0,
      quote: withReasoning ? quoteSelectedWithReasoning(fitted) : quoteSelected(fitted),
      indexOnly: missing,
      mode: 'tag',
    });
    const injected = missing ? 0 : fitted.length;
    const outputTokens = missing ? 0 : tokens;
    const outputBudget = withReasoning ? REASONING_LOAD_BUDGET : budget;

    await updateSession(this.sessionId, (current) => {
      current.pending = {
        kind: 'load',
        id,
        text,
        injected,
        tokens: outputTokens,
        rawMissing: missing,
        segs,
        folded: folded.folded,
        visible: folded.visible,
        mode: 'tag',
        tagCount: found.count,
        ...reasoningFields,
      };
      return current;
    });
    if (missing) {
      recordError(`continuity.load: raw missing for tag ${id}; index only`, 'tag-load-raw');
      return {
        ok: false,
        reason: 'raw-missing',
        id,
        mode: 'tag',
        injected: 0,
        tokens: 0,
        active: false,
        pending: true,
        budget: outputBudget,
        segs: [],
        folded: [],
        visible: [],
        tagCount: found.count,
        ...reasoningFields,
      };
    }
    return {
      ok: true,
      pending: true,
      id,
      mode: 'tag',
      injected,
      tokens: outputTokens,
      active: false,
      budget: outputBudget,
      segs,
      folded: folded.folded,
      visible: folded.visible,
      tagCount: found.count,
      ...reasoningFields,
    };
  }

  /** Exact seqs load: only these, no budget tail truncation, no active change. */
  async loadSeqs({ id, seqs, budget, withReasoning = false }, signal) {
    signal?.throwIfAborted?.();
    let snapshot;
    try {
      snapshot = await this.sessionQuery.readSession(this.agent.session.id);
    } catch (error) {
      recordError(error?.message ?? String(error), 'seq-load');
      snapshot = null;
    }
    const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
    const bySeq = new Map(events.map((event) => [Number(event.seq), event]));
    const missingSeq = seqs.filter((seq) => !bySeq.has(seq));
    if (missingSeq.length > 0) {
      return {
        ok: false,
        reason: 'unknown-seq',
        id: id ?? null,
        mode: 'seqs',
        seqs: missingSeq,
        injected: 0,
        tokens: 0,
        active: false,
      };
    }
    const selected = [];
    for (const seq of seqs) {
      const event = bySeq.get(seq);
      const text = quoteEventText(event);
      if (text.length === 0) continue;
      selected.push({ seq, event, role: eventRole(event), text, tokens: estimateTextTokens(text) });
    }
    const picked = selected.length;
    let reasoned = null;
    if (withReasoning) {
      reasoned = applyReasoningBudget({
        selected,
        bySeq,
        budget: REASONING_LOAD_BUDGET,
      });
    }
    const fitted = withReasoning ? reasoned.selected : selected;
    const segs = fitted.map((entry) => Number(entry.seq));
    const tokens = withReasoning
      ? reasoned.tokens
      : fitted.reduce((sum, entry) => sum + (Number(entry.tokens) || 0), 0);
    const missing = snapshot === null || picked === 0;
    const folds = (await readFolds(this.sessionId)).folds;
    const folded = foldedInfo(folds, fitted);
    const reasoningFields = withReasoning
      ? {
        reasoningInjected: reasoned.reasoningInjected,
        reasoningTokens: reasoned.reasoningTokens,
        skipped: reasoned.skipped,
      }
      : {};
    const text = selectionLoadText({
      id: id ?? null,
      label: id ?? null,
      count: segs.length,
      quote: withReasoning ? quoteSelectedWithReasoning(fitted) : quoteSelected(fitted),
      indexOnly: missing,
      mode: 'seqs',
      foldedNote: folded.foldedNote,
      withReasoning,
      reasoningInjected: withReasoning ? reasoned.reasoningInjected : 0,
      skipped: withReasoning ? reasoned.skipped : 0,
    });
    const injected = missing ? 0 : fitted.length;
    const outputTokens = missing ? 0 : tokens;
    const outputBudget = withReasoning ? REASONING_LOAD_BUDGET : budget;

    await updateSession(this.sessionId, (current) => {
      current.pending = {
        kind: 'load',
        id: id ?? null,
        text,
        injected,
        tokens: outputTokens,
        rawMissing: missing,
        segs,
        folded: folded.folded,
        visible: folded.visible,
        mode: 'seqs',
        ...reasoningFields,
      };
      return current;
    });
    if (missing) {
      return {
        ok: false,
        reason: 'raw-missing',
        id: id ?? null,
        mode: 'seqs',
        injected: 0,
        tokens: 0,
        active: false,
        pending: true,
        budget: outputBudget,
        segs: [],
        folded: [],
        visible: [],
        ...reasoningFields,
      };
    }
    return {
      ok: true,
      pending: true,
      id: id ?? null,
      mode: 'seqs',
      injected,
      tokens: outputTokens,
      active: false,
      budget: outputBudget,
      segs,
      folded: folded.folded,
      visible: folded.visible,
      ...reasoningFields,
    };
  }

  /** Regenerate the tags.md view from tags.json; never read it back. */
  async writeTagsMarkdown(tagsState) {
    try {
      const sessionState = await getSession(this.sessionId);
      let maxSeq = 0;
      try {
        const snapshot = await this.sessionQuery.readSession(this.agent.session.id);
        for (const event of Array.isArray(snapshot?.events) ? snapshot.events : []) {
          const seq = Number(event?.seq);
          if (Number.isInteger(seq) && seq > maxSeq) maxSeq = seq;
        }
      } catch { /* tags view still useful without the tail */ }
      const markdown = renderTagsMd(tagsState, {
        threads: sessionState.threads,
        activeId: sessionState.activeId,
        maxSeq,
      });
      await writeTagsMd(markdown);
    } catch (error) {
      recordError(error?.message ?? String(error), 'tags-md');
    }
  }

  async find(args = {}) {
    const requestedId = requireString(args.id, 'find.id');
    const after = optionalInteger(args.after, 'find.after');
    const before = optionalInteger(args.before, 'find.before');
    const limit = optionalInteger(args.limit, 'find.limit') ?? 20;
    let threads = [];
    try {
      threads = (await getSession(this.sessionId)).threads;
    } catch {
      threads = [];
    }
    const read = await readTagsMigrated(threads);
    if (read.migration.changed) await this.writeTagsMarkdown(read.state);
    const id = canonicalTagId(requestedId, threads);
    let snapshot;
    try {
      snapshot = await this.sessionQuery.readSession(this.agent.session.id);
    } catch (error) {
      recordError(error?.message ?? String(error), 'tag-find');
      snapshot = null;
    }
    const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
    const folds = (await readFolds(this.sessionId)).folds;
    if (id === TAG_ZERO) {
      const t0 = findT0Ranges({ tags: read.state, events, after, before, limit });
      return { ...t0, visible: [], folded: [], covered: t0.count };
    }
    const found = findTagSeqs({ tags: read.state, id, events, after, before, limit });
    const coverage = findResolvedRanges({ tags: read.state, id, events, after, before, limit });
    const visible = [];
    const folded = [];
    for (const seq of found.seqs) {
      if (foldForSeq(folds, seq) === null) visible.push(seq);
      else folded.push(seq);
    }
    return {
      ...found,
      count: coverage.count,
      visible,
      folded,
      ranges: coverage.ranges,
      covered: coverage.count,
      rangeFirst: coverage.first,
      rangeLast: coverage.last,
      rangeSpan: coverage.span,
    };
  }

  /** Apply a tag alias to the matching thread record, if there is one. */
  async applyTagThreadAlias(id, alias) {
    if (alias === undefined) return false;
    try {
      let changed = false;
      await updateSession(this.sessionId, (current) => {
        const thread = current.threads.find((entry) => entry.id === id);
        if (thread !== undefined) {
          thread.alias = alias;
          changed = true;
        }
        return current;
      });
      return changed;
    } catch {
      return false;
    }
  }

  /** Updated tag row for a metadata-only tag call. */
  async tagRow(tagsState, id) {
    let threads = [];
    let activeId = null;
    try {
      const state = await getSession(this.sessionId);
      threads = state.threads;
      activeId = state.activeId;
    } catch {
      threads = [];
      activeId = null;
    }
    const row = tagsView(tagsState, { threads, activeId }).tags.find((entry) => entry.id === id);
    if (row === undefined) return { id };
    const th = threads.find((x) => String(x.id) === String(row.id)
      || String(x.alias ?? '') === String(row.alias ?? '')
      || String(x.id) === String(row.threadId ?? ''));
    return th === undefined
      ? { ...row }
      : { ...row, label: th.label ?? row.label, keywords: Array.isArray(th.keywords) ? th.keywords : row.keywords };
  }

  async tag(args = {}) {
    let id = requireString(args.id, 'tag.id');
    const seqs = integerList(args.seqs, 'tag.seqs');
    const fromSeq = optionalInteger(args.fromSeq, 'tag.fromSeq');
    const toSeq = optionalInteger(args.toSeq, 'tag.toSeq');
    const label = optionalString(args.label);
    const alias = optionalString(args.alias);
    const keywords = Array.isArray(args.keywords)
      ? [...new Set(args.keywords.map((item) => String(item).trim()).filter(Boolean))]
      : undefined;
    let threads = [];
    try {
      threads = (await getSession(this.sessionId)).threads;
    } catch {
      threads = [];
    }
    id = canonicalTagId(id, threads);
    const migrated = await readTagsMigrated(threads);
    if (migrated.migration.changed) await this.writeTagsMarkdown(migrated.state);
    const hasRange = fromSeq !== undefined || toSeq !== undefined;
    const hasMetadata = label !== undefined || alias !== undefined || keywords !== undefined;
    if (seqs !== undefined && hasRange) {
      throw new Error('continuity.tag: use seqs or fromSeq/toSeq, not both');
    }
    if (seqs === undefined && !hasRange && !hasMetadata) {
      throw new Error('continuity.tag: seqs, fromSeq/toSeq, or a metadata field is required');
    }
    const resolvedId = resolveTagIdentity(id, migrated.state, threads);
    if (resolvedId === null && seqs === undefined && !hasRange) {
      return { ok: false, reason: 'unknown-tag-id', id };
    }
    if (resolvedId !== null) id = resolvedId;
    if (hasRange) {
      if (fromSeq === undefined || toSeq === undefined) throw new Error('continuity.tag: pass both fromSeq and toSeq');
      if (fromSeq > toSeq) throw new Error('continuity.tag: fromSeq must be <= toSeq');
      await readTagsWithWarning();
      const result = await updateTags((tags) => {
        const existing = tags.tags[id];
        if (existing === undefined) tags.tags[id] = { label: label ?? id };
        else if (label !== undefined) existing.label = label;
        if (keywords !== undefined) tags.tags[id].keywords = keywords;
        if (alias !== undefined) tags.tags[id].alias = alias;
        tags.runs.push([fromSeq, toSeq, id]);
        tags.updatedAt = new Date().toISOString();
        return tags;
      });
      await this.applyTagThreadAlias(id, alias);
      await this.writeTagsMarkdown(result.state);
      return {
        ok: true,
        id,
        ...(label === undefined ? {} : { label }),
        ...(alias === undefined ? {} : { alias }),
        ...(keywords === undefined ? {} : { keywords }),
        range: [fromSeq, toSeq],
        count: toSeq - fromSeq + 1,
      };
    }
    if (seqs !== undefined) {
      await readTagsWithWarning();
      const result = await updateTags((tags) => tagSeqs(tags, { seqs, id, label, keywords, alias }).state);
      await this.applyTagThreadAlias(id, alias);
      await this.writeTagsMarkdown(result.state);
      return {
        ok: true,
        id,
        ...(label === undefined ? {} : { label }),
        ...(alias === undefined ? {} : { alias }),
        ...(keywords === undefined ? {} : { keywords }),
        seqs,
        count: seqs.length,
      };
    }
    // Metadata-only: no seq ownership changes, no run/override.
    await readTagsWithWarning();
    const result = await updateTags((tags) => {
      const existing = tags.tags[id];
      if (existing === undefined) tags.tags[id] = { label: label ?? id };
      else if (label !== undefined) existing.label = label;
      if (keywords !== undefined) tags.tags[id].keywords = keywords;
      if (alias !== undefined) tags.tags[id].alias = alias;
      tags.updatedAt = new Date().toISOString();
      return tags;
    });
    await this.applyTagThreadAlias(id, alias);
    await this.writeTagsMarkdown(result.state);
    return { ok: true, id, ...(await this.tagRow(result.state, id)) };
  }

  async untag(args = {}) {
    const fromSeq = optionalInteger(args.fromSeq, 'untag.fromSeq');
    const toSeq = optionalInteger(args.toSeq, 'untag.toSeq');
    if (fromSeq === undefined || toSeq === undefined) {
      throw new Error('continuity.untag: fromSeq and toSeq are required');
    }
    if (fromSeq > toSeq) throw new Error('continuity.untag: fromSeq must be <= toSeq');
    await readTagsWithWarning();
    let removedOverrides = 0;
    const result = await updateTags((tags) => {
      tags.runs.push([fromSeq, toSeq, TAG_ZERO]);
      for (const key of Object.keys(tags.overrides)) {
        const seq = Number(key);
        if (seq >= fromSeq && seq <= toSeq) {
          delete tags.overrides[key];
          removedOverrides += 1;
        }
      }
      tags.updatedAt = new Date().toISOString();
      return tags;
    });
    await this.writeTagsMarkdown(result.state);
    return {
      ok: true,
      range: [fromSeq, toSeq],
      count: toSeq - fromSeq + 1,
      removedOverrides,
    };
  }

  async delete(args = {}) {
    const requested = requireString(args.id, 'delete.id');
    const force = args.force === true;
    const state = await getSession(this.sessionId);
    const thread = state.threads.find((entry) => entry.id === requested)
      ?? state.threads.find((entry) => entry.alias === requested);
    if (thread === undefined) return { ok: false, reason: 'unknown-thread-id', id: requested };
    const id = thread.id;
    let rawThread = null;
    try {
      const raw = await readState();
      rawThread = (raw.sessions?.[this.sessionId]?.threads ?? [])
        .find((entry) => entry?.id === id) ?? null;
    } catch {
      rawThread = null;
    }
    const rawSegments = Array.isArray(rawThread?.segments) ? rawThread.segments : null;
    const segments = Array.isArray(thread.segments) ? thread.segments : [];
    const empty = (rawSegments !== null && rawSegments.length === 0)
      || segments.length === 0
      || segments.every((segment) => (Number(segment.tokens) || 0) === 0);
    if (!empty && !force) {
      return { ok: false, reason: 'not-empty', id };
    }

    const tagsRead = await readTags();
    const tags = tagsRead.state;
    const alias = typeof thread.alias === 'string' && thread.alias.length > 0 ? thread.alias : null;
    const tagKeys = Object.keys(tags.tags).filter((key) => (
      key === id
      || tags.tags[key]?.alias === id
      || (alias !== null && tags.tags[key]?.alias === alias)
    ));
    const tagEntries = Object.fromEntries(tagKeys.map((key) => [key, tags.tags[key]]));
    const tagRuns = tags.runs.filter((run) => run[2] === id || (alias !== null && run[2] === alias));
    const tagOverrides = Object.fromEntries(Object.entries(tags.overrides).filter(([, value]) => (
      value === id || (alias !== null && value === alias)
    )));
    const backup = await writeDeletedBackup(id, {
      version: 1,
      deletedAt: new Date().toISOString(),
      id,
      alias,
      thread: rawThread ?? thread,
      normalizedThread: thread,
      tags: { entries: tagEntries, runs: tagRuns, overrides: tagOverrides },
    });

    await updateSession(this.sessionId, (current) => {
      current.threads = current.threads.filter((entry) => entry.id !== id);
      if (current.activeId === id) current.activeId = null;
      if (current.pending?.id === id) current.pending = null;
      return current;
    });
    if (tagKeys.length > 0 || tagRuns.length > 0 || Object.keys(tagOverrides).length > 0) {
      const result = await updateTags((current) => {
        for (const key of tagKeys) delete current.tags[key];
        current.runs = current.runs.filter((run) => run[2] !== id && (alias === null || run[2] !== alias));
        for (const key of Object.keys(current.overrides)) {
          if (current.overrides[key] === id || (alias !== null && current.overrides[key] === alias)) {
            delete current.overrides[key];
          }
        }
        current.updatedAt = new Date().toISOString();
        return current;
      });
      await this.writeTagsMarkdown(result.state);
    } else {
      await this.writeTagsMarkdown(tags);
    }
    return { ok: true, id, backup };
  }

  async retag(args = {}) {
    const from = requireString(args.from, 'retag.from');
    const to = requireString(args.to, 'retag.to');
    let threads = [];
    let activeId = null;
    try {
      const state = await getSession(this.sessionId);
      threads = state.threads;
      activeId = state.activeId;
    } catch {
      threads = [];
      activeId = null;
    }
    const read = await readTagsMigrated(threads);
    const fromId = resolveTagIdentity(from, read.state, threads);
    if (fromId === null) return { ok: false, reason: 'unknown-tag-id', id: from };
    let toId = resolveTagIdentity(to, read.state, threads);
    if (toId === null) {
      const hasContent = read.state.runs.some((run) => run[2] === fromId)
        || Object.values(read.state.overrides).includes(fromId);
      if (!hasContent) return { ok: false, reason: 'unknown-tag-id', id: to };
      toId = to;
    }
    if (fromId === toId) {
      return {
        ok: true,
        from: fromId,
        to: toId,
        tags: tagsView(read.state, { activeId, threads }).tags,
      };
    }
    const result = await updateTags((tags) => retagTags(tags, { from: fromId, to: toId }).state);
    await this.writeTagsMarkdown(result.state);
    return {
      ok: true,
      from: fromId,
      to: toId,
      tags: tagsView(result.state, { activeId, threads }).tags,
    };
  }

  async tags() {
    let activeId = null;
    let threads = [];
    let maxSeq = 0;
    try {
      const sessionState = await getSession(this.sessionId);
      activeId = sessionState.activeId;
      threads = sessionState.threads;
      const snapshot = await this.sessionQuery.readSession(this.agent.session.id);
      for (const event of Array.isArray(snapshot?.events) ? snapshot.events : []) {
        const seq = Number(event?.seq);
        if (Number.isInteger(seq) && seq > maxSeq) maxSeq = seq;
      }
    } catch {
      activeId = null;
      threads = [];
    }
    const read = await readTagsMigrated(threads);
    if (read.migration.changed) await this.writeTagsMarkdown(read.state);
    const view = tagsView(read.state, { activeId, threads, maxSeq });
    return {
      ...view,
      ...(read.corrupt || read.missing
        ? { warning: read.corrupt ? 'tags.json corrupt; using T0' : 'tags.json missing; using T0' }
        : {}),
    };
  }

  async scan(args = {}, signal) {
    const seqs = integerList(args.seqs, 'scan.seqs');
    const fromSeq = optionalInteger(args.fromSeq, 'scan.fromSeq');
    const toSeq = optionalInteger(args.toSeq, 'scan.toSeq');
    if (seqs === undefined && (fromSeq === undefined || toSeq === undefined)) {
      throw new Error('continuity.scan: pass seqs, or both fromSeq and toSeq');
    }
    if (fromSeq !== undefined && toSeq !== undefined && fromSeq > toSeq) {
      throw new Error('continuity.scan: fromSeq must be <= toSeq');
    }
    let snapshot;
    try {
      snapshot = await this.sessionQuery.readSession(this.agent.session.id);
    } catch (error) {
      throw new Error(`continuity.scan: cannot read session: ${error?.message ?? error}`);
    }
    signal?.throwIfAborted?.();
    const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
    return scanEvents({
      events,
      fromSeq,
      toSeq,
      seqs,
      headChars: args.headChars,
      includeReasoning: args.includeReasoning === true,
      types: args.types,
      limit: args.limit,
    });
  }

  async active() {
    const state = await getSession(this.sessionId);
    return activeView(state);
  }

  async list() {
    const state = await getSession(this.sessionId);
    return listView(state);
  }
}

/**
 * Forwarding layer. Keep this list in sync with ThreadsCore; the tool test
 * calls every entry through the facade, so a missing method fails loudly.
 */
export function makeApi(core) {
  return {
    save: (args, signal) => core.save(args, signal),
    load: (args, signal) => core.load(args, signal),
    scan: (args, signal) => core.scan(args, signal),
    find: (args) => core.find(args),
    tag: (args) => core.tag(args),
    untag: (args) => core.untag(args),
    retag: (args) => core.retag(args),
    delete: (args) => core.delete(args),
    tags: () => core.tags(),
    active: () => core.active(),
    list: () => core.list(),
  };
}
