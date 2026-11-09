#!/usr/bin/env node
/**
 * DSH Continuity 体检（独立脚本，不依赖插件是否加载）。
 *
 * 为什么独立：最该诊断的情况就是「插件 client 没加载」——那时候插件自己的工具也不在。
 *
 * 查五件事：
 *   1. 宿主 DSH 版本，以及宿主里有没有插件声明要 inject 的三个 client 包
 *   2. 每个 profile 的 package.json：dsh-continuity 有没有装、是不是 link、在不在 bundles 里
 *   3. 插件目录里 client.js 有没有右侧栏注册（sidebarRightTabs）
 *   4. 结论：宿主太老 / 没进 bundles / 装的是老版本 / 都正常（那是缓存或浏览器）
 *
 * 用法：
 *   node dsh-continuity-doctor.mjs
 *   node dsh-continuity-doctor.mjs --dsh "<DSH 安装目录>" --profile "<profile 目录>"
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const argOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const say = (line = '') => console.log(line);
if (args.includes('--fix-tags')) {
  try {
    const { runMaintenance } = await import('../src/tag-maintenance.mjs');
    const result = await runMaintenance({ mode: 'manual', dryRun: args.includes('--dry-run') });
    say(JSON.stringify(result, null, 2));
    process.exit(result.healthy ? 0 : 1);
  } catch (error) {
    say(`[doctor] tag maintenance failed: ${error?.message ?? error}`);
    process.exit(1);
  }
}
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

const REQUIRED_CLIENT_PACKAGES = [
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-locale',
];

const problems = [];

// ---------- 1. 宿主 ----------
// 注意：DSH_HOME 指的是 ~/.dsh（profile/数据的家），**不是**安装目录——
// 拿它当安装目录会得到"没有 app.asar"的假故障。安装目录只用 --dsh 或候选路径。
const findHostDir = () => {
  const explicit = argOf('--dsh') ?? process.env.DSH_INSTALL ?? null;
  if (explicit) return explicit;
  const candidates = [
    // Windows
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness') : null,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'DeepSeek Harness') : null,
    // macOS
    '/Applications/DeepSeek Harness.app',
    path.join(os.homedir(), 'Applications', 'DeepSeek Harness.app'),
    // Linux（AppImage 解包目录 / deb 安装目录 / 用户目录）
    path.join(os.homedir(), '.local', 'share', 'deepseek-harness'),
    '/opt/DeepSeek Harness',
    '/usr/lib/deepseek-harness',
  ].filter(Boolean);
  // 优先选真的带 app.asar 的那个（存在多个安装时，比如重复安装）。
  const existing = candidates.filter((candidate) => fs.existsSync(candidate));
  const withAsar = existing.find((candidate) => [
    path.join(candidate, 'resources', 'app.asar'),
    path.join(candidate, 'app.asar'),
    path.join(candidate, 'Contents', 'Resources', 'app.asar'),
  ].some((file) => fs.existsSync(file)));
  return withAsar ?? existing[0] ?? null;
};

/** version 文件可能在目录根、Resources/ 里，或 app bundle 的 Contents/ 下。 */
const findVersionFile = (dir) => {
  const candidates = [
    path.join(dir, 'version'),
    path.join(dir, 'Contents', 'version'),
    path.join(dir, 'Resources', 'version'),
    path.join(dir, 'Contents', 'Resources', 'version'),
  ];
  return candidates.find((file) => fs.existsSync(file)) ?? null;
};

// Electron 会把 .asar 当目录（readFileSync 直接失败），要用 original-fs 绕过。
// 这也是"用 DSH 自带的 Electron 当 node 跑"时必须处理的一步。
function readAsarText(file) {
  try {
    const req = createRequire(import.meta.url);
    const originalFs = req('original-fs');
    return originalFs.readFileSync(file).toString('latin1');
  } catch { /* 不是 Electron，或没有 original-fs */ }
  try { return fs.readFileSync(file).toString('latin1'); } catch { return ''; }
}

function hostInfo(dir) {
  const info = { dir, version: null, packages: {} };
  const versionFile = findVersionFile(dir);
  if (versionFile) info.version = fs.readFileSync(versionFile, 'utf8').trim();
  const asar = [
    path.join(dir, 'resources', 'app.asar'),
    path.join(dir, 'app.asar'),
    path.join(dir, 'Contents', 'Resources', 'app.asar'),
    path.join(dir, 'Resources', 'app.asar'),
  ].find((file) => fs.existsSync(file));
  if (!asar) { info.asarMissing = true; return info; }
  const text = readAsarText(asar);
  if (text.length === 0) { info.asarUnreadable = true; return info; }
  for (const name of REQUIRED_CLIENT_PACKAGES) {
    const at = text.indexOf('"name": "' + name + '"');
    if (at < 0) { info.packages[name] = null; continue; }
    const slice = text.slice(at, at + 240);
    const match = /"version":\s*"([^"]+)"/.exec(slice);
    info.packages[name] = match ? match[1] : '(版本未解析)';
  }
  return info;
}

say('DSH Continuity 体检');
say('='.repeat(60));
say(`本机  ${process.platform} · node ${process.version}`);
say('');

const hostDir = findHostDir();
const host = hostDir ? hostInfo(hostDir) : null;
if (!host) {
  say('✗ 没找到 DSH 安装目录（用 --dsh 指定，或设 DSH_INSTALL）。');
  problems.push({ kind: 'no-host', detail: '找不到宿主目录，后面几项无法判定' });
} else {
  say(`宿主目录  ${host.dir}`);
  say(`宿主版本  ${host.version ?? '(没有 version 文件)'}`);
  if (host.asarMissing) {
    say('✗ 宿主里没有 app.asar（便携版或非常规安装）');
    problems.push({ kind: 'no-asar', detail: '找不到 app.asar，无法确认宿主自带的 client 包' });
  } else if (host.asarUnreadable) {
    say('✗ app.asar 读不出来（可能是权限或 asar 处理方式，见 --dsh 指定后重试）');
    problems.push({ kind: 'asar-unreadable', detail: 'app.asar 读不出来，无法确认宿主自带的 client 包' });
  } else {
    for (const name of REQUIRED_CLIENT_PACKAGES) {
      const version = host.packages[name];
      say(`  ${version ? '✓' : '✗'} ${name.padEnd(46)} ${version ?? '宿主里没有'}`);
      if (!version) problems.push({ kind: 'host-too-old', detail: '宿主缺 ' + name });
    }
  }
}

// ---------- 2. profile ----------
function findProfiles() {
  const explicit = argOf('--profile');
  if (explicit) return [explicit];
  // profile 根目录：DSH_PROFILES_ROOT 可覆盖；默认 ~/.dsh/profiles（DSH 桌面与 CLI 共用）
  const roots = [
    process.env.DSH_PROFILES_ROOT ?? path.join(os.homedir(), '.dsh', 'profiles'),
  ];
  const out = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      if (fs.existsSync(path.join(dir, 'package.json'))) out.push(dir);
    }
  }
  return out;
}

say('');
say('profile');
say('-'.repeat(60));
const profiles = findProfiles();
if (profiles.length === 0) {
  say('✗ 没找到 profile（~/.dsh/profiles/<名字>/package.json）。');
  problems.push({ kind: 'no-profile', detail: '找不到 profile，插件装在哪里需要人工确认' });
}

let resolvedPluginDir = null;
let installedAnywhere = false;
for (const dir of profiles) {
  const doc = readJson(path.join(dir, 'package.json'));
  if (!doc) { say(`? ${dir}（package.json 读不了）`); continue; }
  const spec = doc.dependencies?.['dsh-continuity'] ?? null;
  const bundles = Array.isArray(doc.dsh?.profile?.bundles) ? doc.dsh.profile.bundles : [];
  const inBundles = bundles.includes('dsh-continuity');
  say(`${path.basename(dir)}  ${spec ? `装 ${spec}` : '没装 dsh-continuity（这个 profile 不用它）'} · ${inBundles ? '在 bundles' : (spec ? '不在 bundles' : '—')}`);
  if (!spec) continue; // 不用它的 profile 不算问题
  installedAnywhere = true;
  if (!inBundles) problems.push({ kind: 'not-in-bundles', detail: `${path.basename(dir)} 装了但 dsh.profile.bundles 里没有它（装了也不会加载）` });

  // 解析实际目录：link:/file: 用它；否则看 node_modules
  const specPath = /^(?:link|file):(.+)$/.exec(spec);
  const pluginDir = specPath ? specPath[1] : path.join(dir, 'node_modules', 'dsh-continuity');
  if (pluginDir && fs.existsSync(path.join(pluginDir, 'package.json'))) resolvedPluginDir = resolvedPluginDir ?? pluginDir;
}
if (!installedAnywhere) {
  problems.push({ kind: 'not-installed', detail: '没有任何 profile 装 dsh-continuity' });
}

// ---------- 3. 插件 ----------
say('');
say('插件');
say('-'.repeat(60));
if (!resolvedPluginDir) {
  say('✗ 解析不到插件目录（link/file 路径不存在，也没在 node_modules 里）。');
  problems.push({ kind: 'plugin-dir-missing', detail: '插件目录不存在：装过但文件不在了' });
} else {
  const doc = readJson(path.join(resolvedPluginDir, 'package.json'));
  const clientFile = path.join(resolvedPluginDir, 'client.js');
  const hasClient = fs.existsSync(clientFile);
  let clientSource = '';
  try { clientSource = fs.readFileSync(clientFile, 'utf8'); } catch { clientSource = ''; }
  const hasSidebarRight = clientSource.includes('sidebarRightTabs');
  const inject = Array.isArray(doc?.dsh?.client?.inject) ? doc.dsh.client.inject : [];
  say(`目录      ${resolvedPluginDir}`);
  say(`版本      ${doc?.version ?? '(读不到 package.json)'}`);
  say(`client.js ${hasClient ? '在' : '不在'} · 右侧栏注册 ${hasSidebarRight ? '有' : '没有'}`);
  say(`声明注入  ${inject.length > 0 ? inject.join(' · ') : '(没有声明)'}`);
  if (!hasClient) problems.push({ kind: 'no-client-js', detail: '插件目录里没有 client.js（老版本或打包不完整）' });
  if (hasClient && !hasSidebarRight) problems.push({ kind: 'old-client', detail: 'client.js 里没有 sidebarRightTabs：这个版本还不带右侧栏' });
  for (const name of REQUIRED_CLIENT_PACKAGES) {
    if (inject.length > 0 && !inject.includes(name)) {
      problems.push({ kind: 'inject-mismatch', detail: `插件的 dsh.client.inject 里没有 ${name}，可能在找别的宿主 API` });
    }
  }
}

// ---------- 3.5 规则层 ----------
say('');
say('规则层');
say('-'.repeat(60));
const continuityHome = process.env.DSH_CONTINUITY_HOME
  ? process.env.DSH_CONTINUITY_HOME
  : path.join(os.homedir(), '.dsh', 'continuity');
const agentsFile = path.join(os.homedir(), '.dsh', 'AGENTS.md');
const rulesFile = path.join(continuityHome, 'rules.md');
const habitsFile = path.join(continuityHome, 'habits.md');
const agentsText = (() => { try { return fs.readFileSync(agentsFile, 'utf8'); } catch { return ''; } })();
const pointerOk = agentsText.includes('## Continuity 的 rules.md')
  || agentsText.includes('## Continuity 的规则层');
say(`AGENTS 指针  ${pointerOk ? '有' : '缺少'}`);
if (!pointerOk) problems.push({ kind: 'agents-pointer-missing', detail: `AGENTS.md 缺少 Continuity 指针：${agentsFile}` });
for (const [name, file] of [['rules.md', rulesFile], ['habits.md', habitsFile]]) {
  const ok = fs.existsSync(file);
  say(`${name.padEnd(10)} ${ok ? '有' : '缺少'}`);
  if (!ok) problems.push({ kind: 'rules-layer-missing', detail: `${name} 不存在：${file}（先跑 install-templates --apply）` });
}

// ---------- 4. 结论 ----------
say('');
say('结论');
say('-'.repeat(60));
const kinds = new Set(problems.map((problem) => problem.kind));
if (problems.length === 0) {
  say('✓ 宿主、profile、插件、client 声明都对得上。');
  say('  UI 还是不出现 → 界面缓存：硬刷新（Ctrl/Cmd+Shift+R）或重启 GUI。');
  say('  仍没有 → DevTools Console 里找 inject / Cannot find module 的报错，把原文发回来。');
} else {
  for (const problem of problems) say(`✗ [${problem.kind}] ${problem.detail}`);
  say('');
  if (kinds.has('host-too-old')) say('→ 先升 DSH 宿主到带这三个 client 包的版本；宿主不升，插件这边改不了。');
  if (kinds.has('not-in-bundles')) say('→ 把 "dsh-continuity" 加进该 profile 的 dsh.profile.bundles（或重装插件让管理界面写进去）。');
  if (kinds.has('not-installed') || kinds.has('plugin-dir-missing')) say('→ 插件没装好：用管理界面重装，或 npm pack 的 tgz 解到 profile 的 node_modules。');
  if (kinds.has('old-client') || kinds.has('no-client-js')) say('→ 插件版本太旧：升到带右侧栏的 0.4.x。');
  if (kinds.has('inject-mismatch')) say('→ 插件与宿主的 client API 不匹配：宿主与插件版本要一起看。');
}

say('');
say('把整段输出发回即可，不用附别的东西。');
say('');
say('没装 node 也能跑——用 DSH 自带的 Electron 当 node：');
say('  Windows:  set ELECTRON_RUN_AS_NODE=1 && "<DSH 安装目录>\\DeepSeek Harness.exe" --expose-internals dsh-continuity-doctor.mjs');
say('  macOS:    ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" --expose-internals dsh-continuity-doctor.mjs');
say('指定位置：--dsh "<安装目录>"、--profile "<profile 目录>"、DSH_PROFILES_ROOT=<profiles 根>');
