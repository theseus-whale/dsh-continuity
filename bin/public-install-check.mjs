#!/usr/bin/env node
/**
 * Public install read gate.
 *
 * The package manager cannot force a human to read a file. This script is the
 * supported path's gate: it asks five comprehension questions, and only writes
 * an install acknowledgement when all answers are correct. `--verify` checks
 * that the ack still matches the docs and package version.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const docs = {
  baseRules: join(root, 'BASE-RULES.md'),
  install: join(root, 'INSTALL.md'),
  agentsTemplate: join(root, 'templates', 'AGENTS-continuity.md'),
  rulesTemplate: join(root, 'templates', 'rules.md'),
  habitsTemplate: join(root, 'templates', 'habits.md'),
};
const home = process.env.DSH_CONTINUITY_HOME
  ? process.env.DSH_CONTINUITY_HOME
  : join(homedir(), '.dsh', 'continuity');
const agentsFile = join(homedir(), '.dsh', 'AGENTS.md');
const ackFile = join(home, 'public-install-ack.json');
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function readDocs() {
  for (const file of Object.values(docs)) {
    if (!existsSync(file)) {
      console.error(`[read-gate] 缺少必读/模板文件：${file}`);
      process.exit(1);
    }
  }
  return {
    baseRules: sha256(docs.baseRules),
    install: sha256(docs.install),
    agentsTemplate: sha256(docs.agentsTemplate),
    rulesTemplate: sha256(docs.rulesTemplate),
    habitsTemplate: sha256(docs.habitsTemplate),
  };
}

function verify() {
  const expected = readDocs();
  if (!existsSync(ackFile)) {
    console.error(`[read-gate] 没有 ack：${ackFile}`);
    console.error('[read-gate] 先运行 node bin/public-install-check.mjs，读完并通过 9 题。');
    process.exit(1);
  }
  let ack;
  try { ack = JSON.parse(readFileSync(ackFile, 'utf8')); } catch (error) {
    console.error(`[read-gate] ack 无法解析：${error.message}`);
    process.exit(1);
  }
  const problems = [];
  if (ack.version !== pkg.version) problems.push(`version ${ack.version} != ${pkg.version}`);
  for (const key of ['baseRules', 'install', 'agentsTemplate', 'rulesTemplate', 'habitsTemplate']) {
    if (ack.docs?.[key] !== expected[key]) problems.push(`${key} 已变化`);
  }
  if (!existsSync(agentsFile)) problems.push('AGENTS.md 不存在');
  else {
    try {
      const agentsText = readFileSync(agentsFile, 'utf8');
      if (!agentsText.includes('## Continuity 的 rules.md')
        && !agentsText.includes('## Continuity 的规则层')) {
        problems.push('AGENTS.md 缺少 Continuity 指针');
      }
    } catch { problems.push('AGENTS.md 不可读'); }
  }
  for (const file of ['rules.md', 'habits.md']) {
    if (!existsSync(join(home, file))) problems.push(`${file} 不存在（先跑 install-templates）`);
  }
  if (problems.length > 0) {
    console.error('[read-gate] ack/安装失效：' + problems.join('；'));
    console.error('[read-gate] 先跑 node bin/install-templates.mjs --apply，再重新运行本脚本。');
    process.exit(1);
  }
  console.log(`[read-gate] ack 有效：${ackFile}`);
  console.log('[read-gate] AGENTS 指针、rules/habits 模板均存在。');
  process.exit(0);
}

if (process.argv.includes('--verify')) verify();

const hashes = readDocs();
console.log('');
console.log('Continuity public read gate');
console.log(`version: ${pkg.version}`);
console.log('');
console.log('安装前必须完整阅读：');
console.log(`  1. ${docs.baseRules}`);
console.log(`  2. ${docs.install}`);
console.log('');
console.log('这不是形式：下面 9 题全对才会写 ack。答错不会写任何东西。');
console.log('');

const rl = createInterface({ input: process.stdin, output: process.stdout });
let inputClosed = false;
const lineQueue = [];
const waiters = [];
rl.on('line', (line) => {
  const waiter = waiters.shift();
  if (waiter !== undefined) waiter(line);
  else lineQueue.push(line);
});
rl.on('close', () => {
  inputClosed = true;
  while (waiters.length > 0) waiters.shift()('');
});
// A line queue (not rl.question) so piped input and TTY input behave the same.
const ask = (prompt) => {
  process.stdout.write(prompt);
  if (lineQueue.length > 0) return Promise.resolve(lineQueue.shift());
  if (inputClosed) return Promise.resolve('');
  return new Promise((resolve) => waiters.push(resolve));
};
let exitCode = 0;
try {
  await ask('读完后按 Enter 开始：');
  const questions = [
    {
      text: '折叠/压缩之后，原文在哪里？',
      options: ['A. 被删除', 'B. 存档里，可用取回读取', 'C. 只在摘要里'],
      correct: 'B',
    },
    {
      text: '这个 public 包含跨会话投递 / peer_message 吗？',
      options: ['A. 包含', 'B. 不包含'],
      correct: 'B',
    },
    {
      text: '安装前第一件事是什么？',
      options: ['A. 直接装', 'B. 备份、读完、跑 read gate', 'C. 清空 ~/.dsh'],
      correct: 'B',
    },
    {
      text: '线程/标签默认跨会话共享吗？',
      options: ['A. 共享', 'B. 按会话本地存储'],
      correct: 'B',
    },
    {
      text: '装坏之后正确做法是什么？',
      options: ['A. 删掉 ~/.dsh/continuity', 'B. 移除插件并恢复备份', 'C. 继续装直到好'],
      correct: 'B',
    },
    {
      text: '子代理能看到完整记忆/线头吗？',
      options: ['A. 能', 'B. 不能，只看到被给的一小块'],
      correct: 'B',
    },
    {
      text: '看到 [候选]/[话题?] 里当前 T 以外的标签，最符合规则的做法是？',
      options: [
        'A. 忽略，自动归位已经完成',
        'B. 当场判；更像另一条线就 load 过去',
        'C. 只把末行 TAG 改成它，不切',
      ],
      correct: 'B',
    },
    {
      text: '想开一个新话题，正确的 TAG 写法是？',
      options: ['A. TAG: 新词', 'B. TAG: NEW:新词', 'C. TAG: "新词"'],
      correct: 'B',
    },
    {
      text: '安装后还必须做什么，否则规则层是断的？',
      options: [
        'A. 直接开始聊天',
        'B. 合并 AGENTS 指针，并复制 rules/habits 模板',
        'C. 删除 AGENTS.md',
      ],
      correct: 'B',
    },
  ];
  const answers = [];
  for (let index = 0; index < questions.length; index += 1) {
    const item = questions[index];
    console.log(`Q${index + 1}. ${item.text}`);
    for (const option of item.options) console.log(`   ${option}`);
    const answer = (await ask('你的答案（A/B/C）：')).trim().toUpperCase();
    if (!['A', 'B', 'C'].includes(answer)) {
      console.error(`Q${index + 1}: 只接受 A/B/C。`);
      exitCode = 1;
      break;
    }
    answers.push(answer);
    if (answer !== item.correct) {
      console.error('');
      console.error(`Q${index + 1} 不对。没有写 ack。`);
      console.error('回去读 BASE-RULES.md 的“机制事实”和 INSTALL.md 的“安装前/回滚”部分，再运行。');
      exitCode = 1;
      break;
    }
    console.log('');
  }
  if (exitCode === 0) {
    mkdirSync(home, { recursive: true });
    const ack = {
      version: pkg.version,
      docs: hashes,
      answers,
      at: new Date().toISOString(),
    };
    writeFileSync(ackFile, `${JSON.stringify(ack, null, 2)}\n`, 'utf8');
    console.log(`[read-gate] 通过，已写：${ackFile}`);
    console.log('');
    console.log('下一步（确认路径后执行）：');
    console.log(`  node "${join(root, 'bin', 'install-templates.mjs')}" --apply`);
    console.log(`  dsh plugin --profile <profile> add link:${root}`);
    console.log('');
    console.log(`安装后复核：node "${join(root, 'bin', 'public-install-check.mjs')}" --verify`);
  }
} finally {
  rl.close();
}
process.exitCode = exitCode;
