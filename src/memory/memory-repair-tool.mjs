/**
 * memory_repair — the write side of `[continuity:review]`.
 *
 * Review used to end with three advisory lines; that left empty A/B/C/K tables
 * empty forever. This tool makes the repair concrete: append or remove one
 * evidence-backed A/K/C entry in the current session, then let the next index
 * update use it. It never invents content. After a successful write it runs
 * the same bc-relabel step over turns.jsonl, validates, backs up the old index,
 * and only then replaces B. A missing turns file is reported, not hidden.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { sessionFile, sessionDir } from './persona.mjs';
import { computeLabelStamp } from './bc-index-updater.mjs';
import { loadIndexJsonl, saveIndexJsonl } from './bc-index.mjs';
import { loadCMapEntries } from './cmap-file.mjs';

const A_HEADER = '# 概念表：名字 | 描述 | 参考覆盖 | kind\n';
const K_HEADER = '# K 特殊关键词：一行一个\n';
const C_HEADER = '# C 用户词：term => B:概念 | K:关键词 | minB:n | summary\n';
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RELABEL_BIN = path.join(PLUGIN_ROOT, 'bin', 'bc-relabel.mjs');

function readText(file) {
  try { return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); } catch { return ''; }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function backup(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const target = `${file}.bak-review-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, target);
    return target;
  } catch { return null; }
}

function cleanLine(value, field, max = 500) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${field} is required`);
  if (text.length > max) throw new Error(`${field} is too long`);
  if (/[\r\n|]/.test(text)) throw new Error(`${field} must not contain a newline or "|"`);
  return text;
}

function cleanKeyword(value) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error('keyword is required');
  if (/[\r\n]/.test(text)) throw new Error('keyword must be one line');
  return text;
}

function ensureHeader(file, header) {
  const text = readText(file);
  if (text.trim()) return text;
  writeAtomic(file, header);
  return header;
}

function addLine(file, header, line, duplicateTest) {
  ensureHeader(file, header);
  const before = readText(file);
  const lines = before.split(/\r?\n/).filter((item) => item.trim());
  if (lines.some((item) => duplicateTest(item))) return { changed: false, line };
  const bak = backup(file);
  const body = before.endsWith('\n') ? before : `${before}\n`;
  writeAtomic(file, `${body}${line}\n`);
  return { changed: true, line, backup: bak };
}

function removeLine(file, lineTest) {
  const before = readText(file);
  const lines = before.split(/\r?\n/);
  const kept = lines.filter((item) => !lineTest(item));
  if (kept.length === lines.length) return { changed: false, removed: 0 };
  const bak = backup(file);
  writeAtomic(file, kept.join('\n'));
  return { changed: true, removed: lines.length - kept.length, backup: bak };
}

function conceptLabel(line) {
  return String(line).replace(/#.*$/, '').split('|')[0]?.trim() ?? '';
}

function keywordLine(line) {
  return String(line).replace(/#.*$/, '').trim();
}

function cmapTerm(line) {
  return String(line).replace(/#.*$/, '').split('=>')[0]?.trim() ?? '';
}

function parseConcept(line) {
  const parts = String(line).replace(/#.*$/, '').split('|').map((part) => part.trim());
  return {
    label: parts[0] ?? '',
    description: parts[1] ?? '',
    coverage: parts[2] ?? '',
    kind: parts[3] || 'topic',
  };
}

function formatConcept(concept) {
  return [concept.label, concept.description, concept.coverage, concept.kind || 'topic'].join(' | ');
}

function updateConcept(file, label, next) {
  const before = readText(file);
  const lines = before.split(/\r?\n/);
  const index = lines.findIndex((line) => conceptLabel(line) === label);
  if (index < 0) return { changed: false, reason: `concept not found: ${label}` };
  const current = parseConcept(lines[index]);
  const merged = {
    label: next.newLabel || current.label,
    description: next.description || current.description,
    coverage: Number.isInteger(next.coverage) ? String(next.coverage) : current.coverage,
    kind: next.kind || current.kind,
  };
  if (!merged.label || !merged.description) return { changed: false, reason: 'label/description required' };
  const duplicate = lines.some((line, i) => i !== index && conceptLabel(line) === merged.label);
  if (duplicate) return { changed: false, reason: `concept already exists: ${merged.label}` };
  const bak = backup(file);
  lines[index] = formatConcept(merged);
  writeAtomic(file, lines.join('\n'));
  return { changed: true, line: lines[index], label: merged.label, backup: bak };
}

function mergeConcept(file, source, target) {
  const before = readText(file);
  const lines = before.split(/\r?\n/);
  const sourceIndex = lines.findIndex((line) => conceptLabel(line) === source);
  const targetIndex = lines.findIndex((line) => conceptLabel(line) === target);
  if (sourceIndex < 0) return { changed: false, reason: `source concept not found: ${source}` };
  if (targetIndex < 0) return { changed: false, reason: `target concept not found: ${target}` };
  if (sourceIndex === targetIndex) return { changed: false, reason: 'source and target are the same' };
  const bak = backup(file);
  lines.splice(sourceIndex, 1);
  writeAtomic(file, lines.join('\n'));
  return { changed: true, label: target, backup: bak };
}

export function conceptQuality(session, home, label, range = {}) {
  const all = loadIndexJsonl(sessionFile(session, 'bc-index.jsonl', home));
  const sorted = all.slice().sort((a, b) => Number(a.turn) - Number(b.turn));
  const start = Number.isInteger(range.startTurn) ? range.startTurn : null;
  const end = Number.isInteger(range.endTurn) ? range.endTurn : null;
  const target = start === null && end === null
    ? sorted
    : sorted.filter((row) => (start === null || row.turn >= start) && (end === null || row.turn <= end));
  const rest = sorted.filter((row) => !target.includes(row));
  const topLabel = (row) => Object.entries(row.conceptScores ?? {})
    .sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0] ?? '';
  const secondScore = (row) => Number(Object.entries(row.conceptScores ?? {})
    .sort((a, b) => Number(b[1]) - Number(a[1]))[1]?.[1] ?? 0);
  const owned = target.filter((row) => topLabel(row) === label);
  const heldOut = target.filter((_, index) => index % 2 === 1);
  const heldOutTop1 = (heldOut.length > 0 ? heldOut : target).filter((row) => topLabel(row) === label).length;
  const mean = (items) => items.length === 0 ? 0 : items.reduce((sum, row) => sum + Number(row.conceptScores?.[label] ?? 0), 0) / items.length;
  const targetMean = mean(target);
  const otherMean = mean(rest);
  const separation = targetMean - otherMean;
  const siblingMargin = owned.length === 0 ? 0 : owned.reduce((sum, row) => (
    sum + Number(row.conceptScores?.[label] ?? 0) - secondScore(row)
  ), 0) / owned.length;
  const passed = owned.length >= Math.min(2, target.length)
    && heldOutTop1 >= 1
    && separation >= 0.02
    && siblingMargin >= 0.02;
  return {
    label,
    range: [start ?? sorted[0]?.turn ?? null, end ?? sorted.at(-1)?.turn ?? null],
    top1: owned.length,
    targetTurns: target.length,
    heldOutTop1,
    targetMean: Number(targetMean.toFixed(4)),
    otherMean: Number(otherMean.toFixed(4)),
    separation: Number(separation.toFixed(4)),
    siblingMargin: Number(siblingMargin.toFixed(4)),
    passed,
  };
}

/**
 * The last step of a repair: recompute B from A + C + the original turns.
 * A missing turns.jsonl is not silently "fixed"; it is reported so review can
 * say blocked-relabel instead of pretending the labels are healthy.
 */
function relabelB(session, home) {
  const dir = sessionDir(session, home);
  const indexFile = path.join(dir, 'bc-index.jsonl');
  const turnsFile = path.join(dir, 'turns.jsonl');
  const conceptsFile = path.join(dir, 'concepts.md');
  const cmapFile = path.join(dir, 'cmap.md');
  if (!fs.existsSync(indexFile)) return { status: 'needs-index' };
  if (!fs.existsSync(turnsFile)) return { status: 'needs-turns' };
  if (!fs.existsSync(conceptsFile)) return { status: 'needs-concepts' };
  const out = path.join(dir, `bc-index.relabeled-${Date.now()}.jsonl`);
  try {
    execFileSync(process.execPath, [
      RELABEL_BIN,
      '--index', indexFile,
      '--turns', turnsFile,
      '--concepts', conceptsFile,
      '--out', out,
      '--write',
    ], { cwd: PLUGIN_ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 120_000 });
  } catch (error) {
    try { fs.rmSync(out, { force: true }); } catch { /* ignore */ }
    return {
      status: 'failed',
      error: String(error?.stderr ?? error?.message ?? error).trim().slice(0, 800),
    };
  }
  try {
    const before = loadIndexJsonl(indexFile);
    const rows = loadIndexJsonl(out);
    if (rows.length !== before.length) throw new Error(`relabel row count ${rows.length} != ${before.length}`);
    const textByTurn = new Map();
    for (const line of fs.readFileSync(turnsFile, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const item = JSON.parse(line);
      if (Number.isInteger(item.turn) && typeof item.text === 'string') textByTurn.set(item.turn, item.text);
    }
    const conceptsText = fs.readFileSync(conceptsFile, 'utf8');
    const stamp = computeLabelStamp({ conceptsText });
    const cmapTerms = fs.existsSync(cmapFile)
      ? loadCMapEntries(cmapFile).map((entry) => entry.term).filter(Boolean)
      : [];
    for (const row of rows) {
      row.labelStamp = stamp;
      const text = textByTurn.get(row.turn) ?? '';
      row.terms = [...new Set(cmapTerms.filter((term) => text.includes(term)))];
    }
    const scored = rows.filter((row) => Object.keys(row.conceptScores ?? {}).length > 0).length;
    if (scored === 0) throw new Error('relabel produced no conceptScores');
    saveIndexJsonl(out, rows);
    const backup = `${indexFile}.bak-review-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(indexFile, backup);
    fs.renameSync(out, indexFile);
    return { status: 'relabeled', rows: rows.length, scored, labelStamp: stamp, backup };
  } catch (error) {
    try { fs.rmSync(out, { force: true }); } catch { /* ignore */ }
    return { status: 'failed', error: String(error?.message ?? error).slice(0, 800) };
  }
}

function recordAChange(session, home, result) {
  if (!String(result.action ?? '').startsWith('concept_')) return;
  try {
    const file = sessionFile(session, 'a-versions.jsonl', home);
    let version = 1;
    try {
      version = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).length + 1;
    } catch { /* first version */ }
    const entry = {
      at: new Date().toISOString(),
      version,
      action: result.action,
      label: result.label ?? result.merged?.[1] ?? result.merged?.[0] ?? null,
      changed: Boolean(result.changed),
      reverted: Boolean(result.reverted),
      range: result.quality?.range ?? null,
      quality: result.quality ?? null,
      relabel: result.relabel?.status ?? null,
      backup: result.backup ?? null,
      line: result.line ?? null,
      merged: result.merged ?? null,
    };
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch { /* audit must not block the write */ }
}

function repairResult(session, home, payload, relabel, qualityLabel = null, qualityRange = {}) {
  const result = { ...payload };
  if (!result.changed) return JSON.stringify(result);
  result.relabel = relabel ? relabelB(session, home) : { status: 'skipped' };
  if (qualityLabel && result.relabel?.status === 'relabeled') {
    const quality = conceptQuality(session, home, qualityLabel, qualityRange);
    result.quality = quality;
    if (!quality.passed && result.backup && result.relabel.backup) {
      try {
        fs.copyFileSync(result.backup, sessionFile(session, 'concepts.md', home));
        fs.copyFileSync(result.relabel.backup, sessionFile(session, 'bc-index.jsonl', home));
        result.changed = false;
        result.reverted = true;
        result.relabel = { ...result.relabel, status: 'reverted', reason: 'A did not separate target turns from the rest' };
      } catch (error) {
        result.revertError = String(error?.message ?? error);
      }
    }
  }
  recordAChange(session, home, result);
  return JSON.stringify(result);
}

export function createMemoryRepairTool({ home } = {}) {
  return {
    name: 'memory_repair',
    description: 'Fix the current Continuity session\'s A/K/C tables when a [continuity:review] finds empty, missing, or wrong labels. Append, update, remove, or merge ONE evidence-backed A entry, or add/remove K/C. Never invent content without evidence. A changes are relabeled against A + C + turns.jsonl and checked for separation: if the changed concept is not top1 on at least 2 turns with a positive margin, the change is reverted. Missing turns/relabel failures are reported, never hidden.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['concept_add', 'concept_update', 'concept_merge', 'concept_remove', 'keyword_add', 'keyword_remove', 'cmap_add', 'cmap_remove', 'relabel'],
          description: 'Which table to repair, or relabel to recompute B without changing a table. concept_* = A, keyword_* = K, cmap_* = C.',
        },
        label: { type: 'string', description: 'A concept label (concept_add/concept_update/concept_merge/concept_remove).' },
        newLabel: { type: 'string', description: 'New label for concept_update; defaults to the old label.' },
        target: { type: 'string', description: 'Target label for concept_merge; the source label is merged into it.' },
        description: { type: 'string', description: 'A short prototype definition, not a turn summary (concept_add/concept_update). Separate multiple prototypes with ";;"; the labeler takes the max similarity.' },
        coverage: { type: 'integer', description: 'Optional estimated coverage for concept_add.' },
        kind: { type: 'string', enum: ['topic', 'workflow'], description: 'A kind; default topic.' },
        keyword: { type: 'string', description: 'K keyword (keyword_add/keyword_remove).' },
        term: { type: 'string', description: 'C user term (cmap_add/cmap_remove).' },
        concept: { type: 'string', description: 'C mapped concept (cmap_add).' },
        minB: { type: 'integer', description: 'C minimum B score; default 1.' },
        startTurn: { type: 'integer', description: 'Optional target start turn for A quality validation.' },
        endTurn: { type: 'integer', description: 'Optional target end turn for A quality validation.' },
        relabel: { type: 'boolean', description: 'Recompute B after a successful write; default true. Set false only for a table-only edit.' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    async execute(args = {}, exec = {}) {
      const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id;
      if (!sessionId) throw new Error('memory_repair: no current session id');
      const session = String(sessionId);
      const base = sessionDir(session, home);
      if (!fs.existsSync(base)) throw new Error(`memory_repair: session dir not found: ${base}`);
      const action = String(args.action ?? '');

      if (action === 'relabel') {
        return JSON.stringify({ ok: true, action, changed: false, relabel: relabelB(session, home) });
      }

      if (action === 'concept_add') {
        const label = cleanLine(args.label, 'label', 120);
        const description = cleanLine(args.description, 'description');
        const coverage = Number.isInteger(args.coverage) ? Math.max(0, args.coverage) : '';
        const kind = args.kind === 'workflow' ? 'workflow' : 'topic';
        const line = [label, description, coverage, kind].join(' | ');
        const file = sessionFile(session, 'concepts.md', home);
        const result = addLine(file, A_HEADER, line, (item) => conceptLabel(item) === label);
        return repairResult(session, home, { ok: true, action, label, changed: result.changed, file, line, backup: result.backup ?? null }, args.relabel !== false, label, { startTurn: args.startTurn, endTurn: args.endTurn });
      }

      if (action === 'concept_update') {
        const label = cleanLine(args.label, 'label', 120);
        const file = sessionFile(session, 'concepts.md', home);
        const result = updateConcept(file, label, args);
        if (!result.changed) return JSON.stringify({ ok: false, action, reason: result.reason ?? 'not changed' });
        return repairResult(session, home, {
          ok: true, action, label: result.label, changed: true, file, line: result.line, backup: result.backup ?? null,
        }, args.relabel !== false, result.label, { startTurn: args.startTurn, endTurn: args.endTurn });
      }

      if (action === 'concept_merge') {
        const label = cleanLine(args.label, 'label', 120);
        const target = cleanLine(args.target, 'target', 120);
        const file = sessionFile(session, 'concepts.md', home);
        const result = mergeConcept(file, label, target);
        if (!result.changed) return JSON.stringify({ ok: false, action, reason: result.reason ?? 'not changed' });
        return repairResult(session, home, {
          ok: true, action, label: target, changed: true, file, merged: [label, target], backup: result.backup ?? null,
        }, args.relabel !== false, target, { startTurn: args.startTurn, endTurn: args.endTurn });
      }

      if (action === 'concept_remove') {
        const label = cleanLine(args.label, 'label', 120);
        const file = sessionFile(session, 'concepts.md', home);
        const result = removeLine(file, (item) => conceptLabel(item) === label);
        return repairResult(session, home, { ok: true, action, label, changed: result.changed, file, removed: result.removed, backup: result.backup ?? null }, args.relabel !== false);
      }

      if (action === 'keyword_add') {
        const keyword = cleanKeyword(args.keyword);
        const file = sessionFile(session, 'keywords.md', home);
        const result = addLine(file, K_HEADER, keyword, (item) => keywordLine(item) === keyword);
        return repairResult(session, home, { ok: true, action, changed: result.changed, file, line: keyword, backup: result.backup ?? null }, args.relabel !== false);
      }

      if (action === 'keyword_remove') {
        const keyword = cleanKeyword(args.keyword);
        const file = sessionFile(session, 'keywords.md', home);
        const result = removeLine(file, (item) => keywordLine(item) === keyword);
        return repairResult(session, home, { ok: true, action, changed: result.changed, file, removed: result.removed, backup: result.backup ?? null }, args.relabel !== false);
      }

      if (action === 'cmap_add') {
        const term = cleanLine(args.term, 'term', 120);
        const concept = cleanLine(args.concept, 'concept', 120);
        const minB = Number.isInteger(args.minB) ? Math.max(0, args.minB) : 1;
        const line = `${term} => ${concept} | minB:${minB}`;
        const file = sessionFile(session, 'cmap.md', home);
        const result = addLine(file, C_HEADER, line, (item) => cmapTerm(item) === term);
        return repairResult(session, home, { ok: true, action, changed: result.changed, file, line, backup: result.backup ?? null }, args.relabel !== false);
      }

      if (action === 'cmap_remove') {
        const term = cleanLine(args.term, 'term', 120);
        const file = sessionFile(session, 'cmap.md', home);
        const result = removeLine(file, (item) => cmapTerm(item) === term);
        return repairResult(session, home, { ok: true, action, changed: result.changed, file, removed: result.removed, backup: result.backup ?? null }, args.relabel !== false);
      }

      throw new Error(`memory_repair: unknown action ${action}`);
    },
  };
}
