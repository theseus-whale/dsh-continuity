/**
 * `recall` — model-facing candidate lookup over the B+C pointer index.
 * Read-only; no LLM; no session writes.
 */
import path from 'node:path';
import fs from 'node:fs';
import { loadIndexJsonl } from './memory/bc-index.mjs';
import { createCMap, DEFAULT_C_SEED, formatIntervals, GENERIC_CONCEPTS, groupHits, queryFor, recall, renderNote, widthWarning } from './memory/bc-recall.mjs';
import { loadSpecialKeywords, matchSpecialKeywords } from './memory/special-keywords.mjs';
import { loadCMapEntries } from './memory/cmap-file.mjs';
import { loadQueryAliases } from './memory/query-aliases.mjs';
import { loadConcepts } from './memory/concepts-file.mjs';
import { resolveVocabFile, sessionFile } from './memory/persona.mjs';
import { eventText } from './session-log.mjs';

export const name = 'dsh-continuity/recall-tool';

const INJECTED = /^\[(?:抽取|工作线|标签|规则|习惯|技能|归位|候选|存\?|闸|回正|学习|追忆|记忆|continuity:[a-z-]+)\]/;
const MACHINE_PREFIX = /^(?:Current runtime context|Current working directory|Current DSH file policy|Approval prompts|Time sampled)/;

function isHumanEvent(event) {
  const source = event?.data?.source ?? event?.source;
  if (source && typeof source.kind === 'string' && source.kind !== 'user') return false;
  if (source && source.peer === true) return false;
  const text = eventText(event).trim();
  return Boolean(text) && !INJECTED.test(text) && !MACHINE_PREFIX.test(text);
}

function parseDirective(query) {
  const text = String(query ?? '').trim();
  const match = text.match(/^([ABCK])\s*标签\s*[:：]?\s*(.*)$/i)
    ?? text.match(/^([ABCK])\s*[:：]\s*(.*)$/i);
  if (!match) return null;
  return { kind: match[1].toUpperCase(), value: match[2].trim() };
}

async function currentUserText(sessionQuery, exec) {
  if (!sessionQuery || typeof sessionQuery.readSession !== 'function') return '';
  const sessionId = exec?.agent?.session?.id;
  if (sessionId === undefined || sessionId === null) return '';
  const snapshot = await sessionQuery.readSession(sessionId);
  const events = snapshot?.events ?? [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== 'user/message') continue;
    if (!isHumanEvent(event)) continue;
    const text = eventText(event).trim();
    if (text) return text;
  }
  return '';
}

function inventory(records, kind, specialKeywords, cTerms = [], aConcepts = [], aField = null, aKinds = null) {
  const counts = new Map();
  const add = (word) => counts.set(word, (counts.get(word) ?? 0) + 1);
  if (kind === 'A') {
    const known = new Set(aConcepts);
    const field = aField === 'workflow' ? 'workflow' : 'topic';
    for (const concept of aConcepts) counts.set(concept, 0);
    for (const record of records) {
      const fallback = (record.generic ?? []).filter((word) => (aKinds?.[word] ?? 'topic') === field);
      const words = field === 'workflow'
        ? (record.genericWorkflow ?? fallback)
        : (record.genericTopic ?? fallback);
      for (const word of words) if (known.has(word)) add(word);
    }
  } else if (kind === 'B') {
    for (const record of records) for (const word of record.generic ?? []) add(word);
  } else if (kind === 'C') {
    const known = new Set(cTerms);
    for (const record of records) for (const word of record.terms ?? []) if (known.has(word)) add(word);
  } else {
    for (const record of records) {
      const words = new Set((record.keywords ?? []).map((word) => String(word).toLowerCase()));
      for (const keyword of specialKeywords) {
        if (words.has(keyword.toLowerCase())) add(keyword);
      }
    }
  }
  return [...counts.entries()]
    .map(([label, turns]) => ({ label, turns }))
    .sort((a, b) => b.turns - a.turns || a.label.localeCompare(b.label));
}

const LITERAL_STOP = new Set([
  '的', '是', '了', '和', '与', '在', '有', '我', '你', '他', '这', '那',
  '哪个', '什么', '怎么', '怎么样', '为什么', '上次', '之前', '那个',
  '一个', '可以', '如果', '因为', '所以', '然后',
  '会怎么样', '会怎么', '怎么办', '怎么回事', '什么时候', '么时候开',
  '是不是', '有没有', '能不能', '多少', '多久', '对不对', '行不行',
  '可不可以', '那次', '今天', '明天', '昨天', '方案', '刚才', '事情', '问题',
]);

const LITERAL_FRAGMENTS = new Set([
  '说的', '件事', '那个', '这个', '一下', '时候', '上次', '之前', '那事',
  '这事的', '什么', '怎么', '哪个', '多少', '多久',
]);

function isLiteralStop(token) {
  if (LITERAL_FRAGMENTS.has(token)) return true;
  if (/[的了吗呢吧啊嘛]$/.test(token)) return true;
  if (/^[那这哪什怎为多几吧]/.test(token)) return true;
  for (const stop of LITERAL_STOP) {
    if (token === stop || token.startsWith(stop)) return true;
  }
  return false;
}

function literalTokens(query) {
  const text = String(query ?? '');
  const tokens = new Set();
  for (const word of text.match(/[A-Za-z0-9_]+/g) ?? []) {
    const lower = word.toLowerCase();
    if (lower.length >= 3 && !isLiteralStop(lower)) tokens.add(lower);
  }
  for (let size = 2; size <= 4; size += 1) {
    for (let i = 0; i + size <= text.length; i += 1) {
      const part = text.slice(i, i + size);
      if (!/[\u3400-\u9fff]/.test(part)) continue;
      if (!isLiteralStop(part)) tokens.add(part);
    }
  }
  return [...tokens];
}

function literalCandidates(records, query, idfRecords = records, aliases = new Map()) {
  const tokens = literalTokens(query);
  if (tokens.length === 0) return [];
  const weights = new Map(tokens.map((token) => [token, 1]));
  let aliasExpansions = 0;
  for (const token of tokens) {
    for (const alias of aliases.get(token) ?? []) {
      if (aliasExpansions >= 3) break;
      const key = String(alias).trim().toLowerCase();
      if (!key) continue;
      if (!weights.has(key)) weights.set(key, 0.6);
      aliasExpansions += 1;
    }
    if (aliasExpansions >= 3) break;
  }
  const keywordSet = new Set();
  for (const record of records) {
    for (const word of record.keywords ?? []) keywordSet.add(String(word).toLowerCase());
  }
  const matched = [...weights.keys()].filter((token) => keywordSet.has(token));
  if (matched.length === 0) return [];
  const df = new Map(matched.map((token) => [token, 0]));
  for (const record of idfRecords) {
    const words = new Set((record.keywords ?? []).map((word) => String(word).toLowerCase()));
    for (const token of matched) if (words.has(token)) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const n = Math.max(idfRecords.length, 1);
  const idf = new Map([...df.entries()].map(([token, count]) => [token, Math.log((n + 1) / (count + 1)) + 1]));
  return records.map((record) => {
    const words = new Set((record.keywords ?? []).map((word) => String(word).toLowerCase()));
    const hits = matched.filter((token) => words.has(token));
    if (hits.length === 0) return null;
    const score = hits.reduce((sum, token) => sum + (idf.get(token) ?? 0) * (weights.get(token) ?? 1), 0);
    return { ...record, literalScore: Number(score.toFixed(4)), literalTerms: hits };
  }).filter(Boolean).sort((a, b) => b.literalScore - a.literalScore || (b.turn ?? 0) - (a.turn ?? 0));
}

function literalNote(query, hits) {
  const groups = groupHits(hits);
  const label = `字面 "${query}"`;
  const header = groups.length === 1
    ? `[追忆] ${label} -> ${intervalText(groups[0])}`
    : `[追忆] ${label} -> ${groups.length} 个区间 / ${hits.length} 条记录\n${formatIntervals(groups, { max: 5 })}`;
  return `${header}\n如需上下文，可按需前后读更多 turn。`;
}

function indexPath() {
  return process.env.DSH_BC_INDEX
    ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity', 'bc-index.jsonl');
}

function wantsRecent(args, query) {
  if (args.recent === true) return true;
  if (args.recent === false) return false;
  return /上次|最近|刚才|之前|上一次|上回/.test(query);
}

function liveCandidates(events, query, { limit = 10000, sinceTurn = -Infinity, beforeTurn = Infinity } = {}) {
  const hits = [];
  for (const event of events ?? []) {
    const text = eventText(event).trim();
    if (!text || !isHumanEvent(event)) continue;
    if (!text.includes(query)) continue;
    const turn = Number(event?.data?.turn ?? event?.turn);
    const seq = Number(event?.seq);
    if (!Number.isInteger(seq)) continue;
    if (Number.isFinite(turn) && turn < sinceTurn) continue;
    if (Number.isFinite(turn) && turn >= beforeTurn) continue;
    hits.push({
      turn: Number.isFinite(turn) ? turn : null,
      seqStart: seq,
      seqEnd: seq,
      concepts: [],
      status: 'live',
      backfilled: [],
      text: text.replace(/\s+/g, ' ').slice(0, 120),
    });
  }
  return hits.sort((a, b) => (b.turn ?? 0) - (a.turn ?? 0)).slice(0, limit);
}

function intervalText(group) {
  if (group.fromTurn === null || group.fromTurn === undefined) return `seq ${group.fromSeq}-${group.toSeq}`;
  return group.fromTurn === group.toTurn
    ? `turn ${group.fromTurn} / seq ${group.fromSeq}-${group.toSeq}`
    : `turn ${group.fromTurn}-${group.toTurn} / seq ${group.fromSeq}-${group.toSeq}`;
}

function noteForLive(query, hits) {
  const groups = groupHits(hits);
  const head = groups.length === 1
    ? `[追忆] 最近 ${query} -> ${intervalText(groups[0])}`
    : `[追忆] 最近 ${query} -> ${groups.length} 个区间\n${formatIntervals(groups)}`;
  return `${head}\n如需上下文，可按需前后读更多 turn。`;
}

export function createRecallTool({ file = indexPath(), sessionQuery = null, cmapFile = null, conceptsFile = null, keywordsFile = null, literalRecords = null, aliasesFile = null } = {}) {
  return {
    name: 'recall',
    description: 'Look up candidate memory turns. Call with no query to interpret the current user message; call with A标签/B标签/C标签/K标签 (optionally plus a value) to inspect or search one namespace. Returns bounded turn/seq pointers; open the cited original before relying on it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Text to look up, or a namespace directive: A标签 / B标签 / C标签 / K标签, optionally followed by a value.' },
        recent: { type: 'boolean', description: 'Prefer the current session, newest first. Defaults to true when the text contains 上次/最近/之前.' },
        sinceTurn: { type: 'integer', description: 'Optional lower turn bound.' },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    timeoutMs: 30_000,
    async execute(args = {}, exec = {}) {
      let raw = String(args.query ?? '').trim();
      if (!raw) {
        try {
          raw = await currentUserText(sessionQuery, exec);
        } catch { /* fall through to the error below */ }
      }
      if (!raw) return JSON.stringify({ ok: false, error: 'query-or-session-required' });

      const sessionId = exec?.agent?.session?.id;
      const sessionIndexFile = sessionId === undefined || sessionId === null
        ? file
        : path.join(path.dirname(file), 'sessions', String(sessionId), 'bc-index.jsonl');
      const records = fs.existsSync(sessionIndexFile) ? loadIndexJsonl(sessionIndexFile) : [];
      const conceptsPath = conceptsFile ?? (sessionId === undefined || sessionId === null
        ? resolveVocabFile('continuity', 'concepts.md')
        : sessionFile(sessionId, 'concepts.md'));
      const aRows = loadConcepts(conceptsPath);
      const aConcepts = aRows.map((row) => row.label);
      const aKinds = Object.fromEntries(aRows.map((row) => [row.label, row.kind]));
      const topicConcepts = aRows.filter((row) => row.kind !== 'workflow').map((row) => row.label);
      const workflowConcepts = aRows.filter((row) => row.kind === 'workflow').map((row) => row.label);
      const aliasesPath = aliasesFile ?? (sessionId === undefined || sessionId === null
        ? resolveVocabFile('continuity', 'aliases.md')
        : sessionFile(sessionId, 'aliases.md'));
      const cmapPath = cmapFile ?? (sessionId === undefined || sessionId === null
        ? resolveVocabFile('continuity', 'cmap.md')
        : sessionFile(sessionId, 'cmap.md'));
      const keywordsPath = keywordsFile ?? (sessionId === undefined || sessionId === null
        ? resolveVocabFile('continuity', 'keywords.md')
        : sessionFile(sessionId, 'keywords.md'));
      const aliases = loadQueryAliases(aliasesPath);
      const cmap = createCMap([...DEFAULT_C_SEED, ...loadCMapEntries(cmapPath)]);
      const specials = fs.existsSync(keywordsPath) ? loadSpecialKeywords(keywordsPath) : [];
      const directive = parseDirective(raw);

      if (directive && !directive.value) {
        return JSON.stringify({
          ok: true,
          mode: 'labels',
          kind: directive.kind,
          labels: inventory(
            records,
            directive.kind,
            specials,
            [...cmap.terms.keys()],
            directive.kind === 'A' ? topicConcepts : [],
            directive.kind === 'A' ? 'topic' : null,
            aKinds,
          ),
        });
      }

      if (directive?.kind === 'A' && ['topic', 'workflow'].includes(String(directive.value).toLowerCase())) {
        const requested = String(directive.value).toLowerCase();
        const selected = requested === 'workflow' ? workflowConcepts : topicConcepts;
        return JSON.stringify({
          ok: true,
          mode: 'labels',
          kind: 'A',
          scope: requested,
          labels: inventory(records, 'A', specials, [...cmap.terms.keys()], selected, requested, aKinds),
        });
      }

      if (directive?.kind === 'A' && directive.value) {
        const wanted = directive.value.trim();
        const concept = aConcepts.find((label) => label === wanted)
          ?? aConcepts.find((label) => label.includes(wanted) || wanted.includes(label));
        if (!concept) {
          return JSON.stringify({ ok: false, error: 'unknown-a-label', labels: aConcepts });
        }
        const hits = records
          .filter((record) => {
            const field = aKinds[concept] === 'workflow' ? 'genericWorkflow' : 'genericTopic';
            const values = Array.isArray(record[field])
              ? record[field]
              : (record.generic ?? []).filter((word) => (aKinds[word] ?? 'topic') === aKinds[concept]);
            return values.includes(concept);
          })
          .map((record) => ({
            turn: record.turn,
            seqStart: record.seqStart,
            seqEnd: record.seqEnd,
            concepts: record.generic ?? [],
            status: record.status,
            backfilled: record.backfilled ?? [],
            score: null,
            literalTerms: [],
          }));
        const groups = groupHits(hits);
        return JSON.stringify({
          ok: true,
          mode: 'locate',
          query: concept,
          via: 'A',
          kind: 'recall',
          note: hits.length > 0
            ? `[追忆] A:${concept} -> ${groups.length} 个区间 / ${hits.length} 条记录`
            : `[追忆] A:${concept} 暂无记录`,
          intervals: groups.map((group) => ({
            fromTurn: group.fromTurn,
            toTurn: group.toTurn,
            fromSeq: group.fromSeq,
            toSeq: group.toSeq,
            turns: group.turns,
          })),
          candidates: hits,
        });
      }

      let special = [];
      let facet = '';
      let lookup = raw;
      if (directive?.value) {
        raw = directive.value;
        if (directive.kind === 'K') {
          special = matchSpecialKeywords(raw, specials);
          if (special.length === 0) special = [raw];
        }
        facet = GENERIC_CONCEPTS.find((concept) => raw.includes(concept)) ?? '';
        lookup = facet || (directive.kind === 'B' || directive.kind === 'C' ? raw : special[0] || raw);
      } else {
        special = matchSpecialKeywords(raw, specials);
        facet = GENERIC_CONCEPTS.find((concept) => raw.includes(concept)) ?? '';
        const extracted = queryFor(raw, { records, cmap });
        lookup = facet || (special.length > 0 ? special[0] : (extracted && extracted !== raw ? extracted : raw));
      }

      const recent = wantsRecent(args, raw);
      const sinceTurn = Number.isInteger(args.sinceTurn) ? args.sinceTurn : -Infinity;

      if (recent && sessionQuery && typeof sessionQuery.readSession === 'function') {
        const sessionId = exec?.agent?.session?.id;
        if (sessionId !== undefined && sessionId !== null) {
          try {
            const snapshot = await sessionQuery.readSession(sessionId);
            const live = liveCandidates(snapshot?.events ?? [], lookup, {
              sinceTurn,
              beforeTurn: Number.isInteger(exec?.agent?.lastTurn) ? exec.agent.lastTurn : Infinity,
            });
            if (live.length > 0) {
              const groups = groupHits(live);
              return JSON.stringify({
                ok: true,
                mode: 'locate',
                query: raw,
                via: 'live',
                recent: true,
                note: noteForLive(raw, live),
                intervals: groups.map((group) => ({
                  fromTurn: group.fromTurn,
                  toTurn: group.toTurn,
                  fromSeq: group.fromSeq,
                  toSeq: group.toSeq,
                  turns: group.turns,
                })),
                candidates: live,
              });
            }
          } catch { /* fall back to the static index */ }
        }
      }

      const result = recall({ records, cmap, query: lookup, specialKeywords: special });
      if (records.length === 0) return JSON.stringify({ ok: false, error: 'index-empty', file });
      let hits = recent
        ? [...(result.hits ?? [])].sort((a, b) => (b.turn ?? 0) - (a.turn ?? 0))
        : (result.hits ?? []);
      let via = result.via ?? null;
      let warning = widthWarning(result, groupHits(hits));
      let note = hits.length > 0 && recent
        ? (() => {
          const groups = groupHits(hits);
          const custom = groups.length === 1
            ? `[追忆] 最近 ${raw} -> ${intervalText(groups[0])}\n如需上下文，可按需前后读更多 turn。`
            : `[追忆] 最近 ${raw} -> ${groups.length} 个区间\n${formatIntervals(groups)}\n如需上下文，可按需前后读更多 turn。`;
          return warning ? `${custom}\n${warning}` : custom;
        })()
        : renderNote(result);

      // Literal fallback: only when no B/C/K hit at all. Never override an
      // existing exact K/C hit (q2-style) with a broader literal list.
      if ((result.hits?.length ?? 0) === 0) {
        const literal = literalCandidates(records, raw, literalRecords ?? records, aliases).slice(0, 5);
        if (literal.length > 0) {
          const seen = new Set(literal.map((hit) => hit.turn));
          hits = [...literal, ...hits.filter((hit) => !seen.has(hit.turn))];
          via = 'literal';
          warning = null;
          note = literalNote(raw, literal);
        }
      }

      const groups = groupHits(hits);
      return JSON.stringify({
        ok: true,
        mode: 'locate',
        query: raw,
        kind: via === 'literal' ? 'recall' : result.kind,
        via,
        recent,
        note,
        warning,
        intervals: groups.map((group) => ({
          fromTurn: group.fromTurn,
          toTurn: group.toTurn,
          fromSeq: group.fromSeq,
          toSeq: group.toSeq,
          turns: group.turns,
        })),
        candidates: hits.slice(0, 20).map((hit) => ({
          turn: hit.turn,
          seqStart: hit.seqStart,
          seqEnd: hit.seqEnd,
          concepts: hit.generic,
          status: hit.status,
          backfilled: hit.backfilled ?? [],
          score: hit.literalScore ?? null,
          literalTerms: hit.literalTerms ?? [],
        })),
      });
    },
  };
}
