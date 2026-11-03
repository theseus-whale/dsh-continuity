# Session 布局与权限 — 4.9.102

这是本包路径/权限的权威文档。若其他文档与它冲突，以本文为准。

## 1. 一个 session，一套完整记忆

```text
~/.dsh/continuity/sessions/<sessionId>/
  bc-index.jsonl          B 指针索引，只属于这个 session
  bc-index-state.json     索引游标
  audit-state.json        审计游标
  expand-hint.jsonl       待注入审计提示
  concepts.md             A: 名字 | 描述词 | 覆盖 | kind
  cmap.md                 C: 用户词 -> 概念
  keywords.md             K: 精确名
  aliases.md              别名
  rules.md                硬规则，从 templates/rules.md 起
  habits.md               软偏好，从 templates/habits.md 起
  rebuild.md              本地重建说明
  turns.jsonl             可选，relabel 用
  dropped-ranges.json     本 session 的合并覆盖（只属于本 session）
```

以上全部是 session-local。任何 session 都不读另一个 session 的 A/C/K、
rules、habits、index、审计、提示或 dropped-ranges。

新 session：

```text
A/C/K 空
rules.md   <- templates/rules.md
habits.md  <- templates/habits.md
rebuild.md <- 空壳
index      <- 第一次 pre-step
```

## 2. 共享文件

```text
~/.dsh/continuity/
  session-persona.json       sessionId -> 身份
  personas/<pid>/persona.json {"enabled": true|false}
  folds.json                 全局折叠历史
  passes.jsonl               全局 pass 回执
  context-log.jsonl          上下文测量
  handoff-pending.json       交接标记
```

`session-persona.json` 只解析身份，不选择词表路径。  
`persona.json` 只是启用开关。

`personas/<pid>/concepts.md|cmap.md|keywords.md|aliases.md` 是**弃用归档**，
不是读取路径。

## 3. 权限

### 内部引擎

continuity preset 挂载的引擎可以读写：

```text
自己的 session 目录（含 dropped-ranges.json）
folds.json / passes.jsonl / context-log.jsonl
```

这是宿主代码，不是模型工具。

### 模型工具

普通工具调用可以碰：

```text
workspace 文件
自己的 sessions/<sessionId>/ 目录
```

不能碰：

```text
另一个 session 的 sessions/<other>/
personas/
session-persona.json
folds.json / passes.jsonl
continuity 根目录的 rules.md / habits.md
```

守卫在 `src/session-guard.mjs`。它只检查带路径的参数，不扫描完整消息/文件
正文；`send_message`、`peer_message`、`present` 不受影响。

守卫是 **best effort**，不是 OS ACL。任意有完整文件权限的代码可以绕过；
强隔离需要 OS ACL/容器。

### 禁用的 persona

禁用的 persona：

```text
面板：persona-disabled
pre-step：跳过
普通 workspace 工具：仍可用
continuity 路径：拒绝
```

## 4. Preset

| session | 自己的一套 | 原生工具 |
|---|---|---|
| continuity preset | A/B/C/K/rules/habits/index | `recall`、`session_log`、band 引擎 |
| standard preset | A/B/C/K/rules/habits/index | 没有原生 recall/session_log；原生 compaction-basic 80% |
| 禁用 persona | 不启用 | 只有 workspace 工具 |

standard session 仍有面板和自己的文件，但没有 continuity band 引擎和原生
recall/session_log。

preset 在第一个 turn 后固定。`agentPresets.select` 对已启动 session 返回
`agent-preset/locked`。改 session header 不是受支持的迁移路径。

## 5. 不变量

```text
一个 session 拥有完整一套。
不继承词表/规则/习惯。
任何 session 不得修改另一个 session 的 continuity 文件。
`personas/` 已弃用。
全局 folds/passes 归引擎，不由模型编辑。
候选不是事实；必须打开 turn/seq。
[gist] 是重建，不是原文。
```

## 维护者访问（operator）

默认没有跨 session 访问。需要人工维护另一个 session 时，在
`~/.dsh/continuity/operator-sessions.json` 写一个显式 session id 数组：

```json
["session-..."]
```

`session-guard` 只对这份清单里的 session 放行；清单为空或不存在时，仍按
persona + 本 session 的规则拦截。这个文件是维护入口，不是日常权限。