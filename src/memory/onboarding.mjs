/**
 * First-run onboarding and scaffolding.
 *
 * The onboarding is a user/message appended through the same session.append
 * path used by the audit injection. Completion is only recorded after the
 * marker is actually present in the next decision's messages.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { contextMessage } from '../threads.mjs';

const MARKER = '[continuity:boot]';
const DEFAULT_HOME = process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();
const DEFAULT_DIR = path.join(DEFAULT_HOME, '.dsh', 'continuity');

export function onboardingText(marker = MARKER) {
  return [
    `${marker} 这个环境有一套连续性记忆，先记住这几件事：`,
    '',
    '0. 以 [continuity:*] 开头的 user 消息是插件注入，不是人说的。',
    '1. 取：需要回忆时调用 recall(query)；它返回 [追忆] 指针，不直接给全文。',
    '2. 存：重要结论写进当前 session 的目录或工作区 log，不要只留在上下文里。',
    '3. 长：A 表在当前 session 目录的 concepts.md；它由这个 session 的语料逐步长成，不继承别的 session。',
    '4. 验：用 recall 打开真实 turn/seq 再下结论；候选不是事实。',
    '5. 审计：每 200 轮会自动来一次 [continuity:audit]，你不用排期；扫一眼，跳过叙事即可。',
    '6. 找回靠“词”不靠“话题”：给具体名字/术语（跑团、dataplan、换箍）能定位；“之前那个事”基本不中。想让它能找回，就把名字写进 keywords.md 或 cmap.md。',
    '7. B 标签（每轮 top3）只用于展示，不参与找回；真正四条路是 字面+别名 / K / C。',
    '8. 表各管什么：keywords=精确名，cmap=用户词，aliases=中英映射，concepts=概念表（展示+算分，不参与查询）。',
    '9. 重建：如果这个 session 已有很长历史（>200 轮）而记忆是空的，不要从零编概念；看 ~/.dsh/continuity/rebuild.md 按九步建索引。',
    '',
    'A 表经验边界：topic 条数约 0.6√N，每次最多 +2；两条 topic 覆盖 Jaccard >0.6 就合并；workflow 不参与合并。',
    '只有 session_log 里 role=user 的消息才算真的送达；delivered/日志不算。',
    '',
    '你可以改自己的 rules/habits，也可以拒绝这些建议；插件不替你做价值判断。',
  ].join('\n');
}

export const ONBOARDING = onboardingText(MARKER);

const SCAFFOLDS = {
  'concepts.md': '# 概念表：名字 | 描述词 | 参考覆盖\n# 由你的语料生成；空表不等于回退别人的表。\n',
  'cmap.md': '# C 用户词：term => B:概念 | K:关键词 | minB:n | summary\n',
  'keywords.md': '# K 特殊关键词：一行一个\n',
  'aliases.md': '# 别名：term => alias / alias（只放跨语言标识符）\n',
  'rebuild.md': '# 重建宫殿（九步）\n# 1 数历史 2 建索引 3 补 vec/chatter 4 种 K 5 种 A\n# 6 重标 7 种 C/别名 8 验收 9 启动审计\n# 细节见包内 templates/rebuild.md；每步先备份，失败回滚。\n',
};

export function bootstrapPaths(home = DEFAULT_HOME) {
  const dir = path.join(home, '.dsh', 'continuity');
  return { dir, stateFile: path.join(dir, 'bootstrap.json') };
}

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}
function writeState(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Create only missing session files. Never overwrite an existing table. */
export function ensureSessionScaffolds({ sessionId = null, home = DEFAULT_HOME } = {}) {
  if (!sessionId) return [];
  const dir = path.join(bootstrapPaths(home).dir, 'sessions', String(sessionId));
  fs.mkdirSync(dir, { recursive: true });
  const created = [];
  for (const [name, body] of Object.entries(SCAFFOLDS)) {
    const target = path.join(dir, name);
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, body, 'utf8');
      created.push(name);
    }
  }
  return created;
}

/** Create only missing files. Never overwrite an existing table. */
export function ensureScaffolds({ home = DEFAULT_HOME, stateFile = null } = {}) {
  const paths = bootstrapPaths(home);
  const file = stateFile ?? paths.stateFile;
  const state = readState(file);
  if (state?.status === 'done') return [];
  fs.mkdirSync(paths.dir, { recursive: true });
  const created = [];
  for (const [name, body] of Object.entries(SCAFFOLDS)) {
    const target = path.join(paths.dir, name);
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, body, 'utf8');
      created.push(name);
    }
  }
  return created;
}

function markerNeedles(marker) {
  const needles = [marker];
  const uuid = String(marker).split(':').pop();
  if (uuid && uuid !== marker) needles.push(uuid);
  return needles;
}

function hasMarker(messages = [], marker = MARKER) {
  const needles = markerNeedles(marker);
  for (const message of messages ?? []) {
    const content = message?.content;
    const text = Array.isArray(content)
      ? content.map((part) => part?.type === 'text' ? part.text : '').join('')
      : String(content ?? '');
    if (needles.some((needle) => text.includes(needle))) return true;
  }
  return false;
}

function sessionHasMarker(session, marker = MARKER) {
  if (!session) return false;
  try {
    if (typeof session.deriveMessages === 'function' && hasMarker(session.deriveMessages(), marker)) return true;
  } catch { /* fall through */ }
  const nodes = Array.isArray(session.surface?.nodes) ? session.surface.nodes : [];
  for (const seq of nodes.slice(-80)) {
    try {
      const event = session.eventAt?.(seq);
      const message = event?.data?.message;
      if (hasMarker([message], marker)) return true;
    } catch { /* ignore */ }
  }
  return false;
}

/**
 * Call once per pre-step before the normal note.
 * Returns true when onboarding was appended this step.
 */
export function maybeOnboard({ session = null, messages = [], home = DEFAULT_HOME, stateFile = null } = {}) {
  const paths = bootstrapPaths(home);
  const file = stateFile ?? paths.stateFile;
  let state = readState(file);
  if (state?.status === 'done') return false;
  if (!state) state = { version: 1, status: 'new', retries: 0 };
  if (!state.marker) state.marker = `${MARKER}:v1:${randomUUID()}`;
  if (hasMarker(messages, state.marker) || sessionHasMarker(session, state.marker)) {
    writeState(file, { ...state, status: 'done', completedAt: new Date().toISOString(), retries: state.retries ?? 0 });
    return false;
  }
  if ((state.retries ?? 0) >= 3) {
    writeState(file, { ...state, status: 'failed', completedAt: new Date().toISOString() });
    return false;
  }
  ensureScaffolds({ home, stateFile: file });
  ensureSessionScaffolds({ sessionId: session?.id, home });
  if (!session || typeof session.append !== 'function') return false;
  session.append('user/message', contextMessage(onboardingText(state.marker)), { surfaceOp: 'append' });
  writeState(file, {
    ...state,
    status: 'pending',
    injectedAt: new Date().toISOString(),
    retries: (state.retries ?? 0) + 1,
    scaffolds: ['concepts.md', 'cmap.md', 'keywords.md', 'aliases.md', 'rebuild.md'],
  });
  return true;
}
