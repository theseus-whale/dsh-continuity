# dsh-continuity 4.11.3

给 DSH 的长上下文连续性插件。每个 session 拥有自己完整的一套记忆；
persona 只是身份/启用标签。

```text
session  = 哪一段对话
persona  = 哪个身份被允许运行（启用开关）
```

## 它做什么

```text
compaction      压缩带控制；session 内 pass 回执 + passes.jsonl
index           每个完成的人类轮次一条指针
A               每个 session 自己的概念表，分 topic / workflow
B               每轮标签（展示、特征材料）
C               每个 session 自己的用户词表
K               每个 session 自己的精确名
rules/habits    每个 session 自己的规则/偏好，从插件根模板起
recall          A / B / C / K + 字面，只查当前 session
panel           每个 session 自己的 A/B/C/K
peer_message    明确投递给另一个 live session
```

不包含额外的提示词分类、自动标注或工作线注入；本包只负责记忆索引、压缩和检索。

## 每个 session 的完整一套

```text
~/.dsh/continuity/sessions/<sessionId>/
  bc-index.jsonl
  bc-index-state.json
  audit-state.json
  expand-hint.jsonl
  concepts.md      A 表（名字 | 描述词 | 覆盖 | kind）
  cmap.md          C 表
  keywords.md      K 表
  aliases.md       别名
  rules.md         硬规则，从 templates/rules.md 起
  habits.md        软偏好，从 templates/habits.md 起
  rebuild.md       本地重建说明
  dropped-ranges.json  本 session 的合并覆盖（seq 空间只属于本 session）
```

共享/诊断：

```text
~/.dsh/continuity/
  session-persona.json        sessionId -> 身份
  personas/<pid>/persona.json {"enabled": true}
  folds.json
  passes.jsonl
  context-log.jsonl
```

- A/C/K/rules/habits **不继承**另一个 session。
- 新 session：A/C/K 空，rules/habits 从插件根模板起。
- `personas/` 是弃用归档，已经不是读取路径。
- `session-persona.json` 只决定身份/启用，不决定词表路径。

## 安装

```text
dsh-continuity-4.11.3.tgz
```

装进目标 profile，备份 `~/.dsh/continuity`，重启 DSH。  
进程是快照：只复制包不重启，运行时行为不变。

## recall

```text
recall()
recall({ query: "项目词", recent: true })
recall({ query: "A标签" })                 // 只看 topic
recall({ query: "A标签:topic" })
recall({ query: "A标签:workflow" })
recall({ query: "A标签:示例主题" })         // 任意 A 概念
recall({ query: "B标签" })
recall({ query: "C标签" })
recall({ query: "K标签" })
```

- 索引和 A/C/K 只读当前 session 的目录。
- A 直接查是“区域浏览”；B/C/K/字面是“精确点位”。
- `via` 是 `A | B | C | K | live`。
- 候选不是事实；必须打开对应 turn/seq。

### 词表刷新

- `concepts.md` / `cmap.md` 的 mtime 会在下一次 pre-step 检查，变了就重建本 session 的 labeler/cmap；不需要重启。
- `keywords.md` 在索引时读取，下一轮生效。
- `aliases.md` 由 recall 每次读取。
- 旧记录不会自动重标；新规则只作用于新轮次。

## 注入前缀

```text
[continuity:boot]    引导
[continuity:audit]   审计
[continuity:fold]    压缩回执
```

插件注入的 `role=user` 消息都以 `[continuity:*]` 开头。  
`[追忆]` 是 recall 的 tool result，不是 user 通道注入。

## rules 头部

`rules.md` 按 H2 标题汇总。截断时写：

```text
…（共 18 节，仅显示前 13 节）
```

数字从当前文件现算，不硬编码。

## session 启用 / 面板

```text
session-persona.json:
  <sessionId> -> continuity | <pid>
  default -> continuity

personas/<pid>/persona.json:
  {"enabled": true} -> 面板 + pre-step 启用
  缺失/禁用          -> persona-disabled，关闭 tab
```

`continuity` 在旧安装里没文件也默认启用。  
非 continuity session 也可以启用，但它的 A/C/K/rules/habits 仍然是
session-local，不继承 Continuity 的。

## 隔离边界

插件路径是 session-local。宿主还装了一个 best-effort 工具守卫：
session 只能碰自己的 `sessions/<id>/`，不能碰别的 session 的 continuity 文件。

这**不是 OS 安全边界**。拥有完整文件权限的任意代码可以绕过；强隔离需要
OS ACL/容器。守卫用于普通 edit/write/shell 工具。

## 标签版本

新记录用 `labelVersion: 2`：

```text
genericTopic      [top topic]
topicScore        top topic 分数
topicConfidence   normal | low | weak（仅展示）
genericWorkflow   [top1, top2]
generic           topic + workflow 并集
conceptScores     选中的候选分数
```

旧记录是 `labelVersion: 1`，没有 `topicScore`；不原地回填。

## 代码地图

```text
src/index.mjs                 宿主路由、面板 JSON、安装
src/engine.mjs                压缩带、pass 回执、gist/fold
src/state.mjs                 pass log、dropped-ranges
src/policy.mjs                压缩带数学与 floor
src/recall-tool.mjs           A/B/C/K 检索，session 路径
src/memory/bc-pre-step.mjs    每 session 调度
src/memory/bc-index.mjs       JSONL 指针编解码
src/memory/bc-index-updater.mjs 标签 + 追加一轮
src/memory/bc-panel-state.mjs 面板投影
src/memory/concepts-file.mjs  A 解析（kind: topic|workflow）
src/memory/persona.mjs        session -> 身份/路径
src/memory/onboarding.mjs     boot marker/空壳
src/memory/bc-audit.mjs       审计 + 待注入提示
src/threads-store.mjs         每 session rules/habits
src/folds-store.mjs           folds.json 历史
src/session-guard.mjs         best-effort 工具路径守卫
client.js                     右侧面板
cordis.patch.yml              bundle patch
```

## 文档

```text
README.md                     本文件
RELEASE-NOTES.md              本版说明
CHANGELOG.md                  变更记录
PANEL.md                      面板排错与诊断
bin/panel-check.mjs           面板/宿主路由自检
docs/README.md                文档索引
docs/SESSION-LAYOUT.md        权威路径、角色、权限
docs/ARCHITECTURE.md          当前架构
docs/NEW-INSTANCE-HANDOFF.md  新实例交接
guides/00-READ-FIRST.md       经典 00–05 说明书
guides/01-INSTALL.md
guides/02-TABLES.md
guides/03-AUDIT.md
guides/04-REBUILD.md          九步重建
guides/05-FIRST-RUN.md
templates/rebuild.md          当前布局的重建流程
```

## 许可证与责任

```text
LICENSE                  MIT
DISCLAIMER.md            责任声明（使用前必读）
PRIVACY.md               数据与隐私
SECURITY.md              安全模型与报告方式
THIRD-PARTY-NOTICES.md   模型/依赖声明
```

本软件是实验性项目，不是 DeepSeek 官方产品，按“现状”提供，不保证数据不丢失。
使用前请备份 `~/.dsh/continuity`，并先在干净 profile 测试。

## 安全

不要从 session 内修改已安装的插件、`cordis.patch.yml`、package 文件或
lockfile。插件变更走独立副本、测试、备份、替换。
