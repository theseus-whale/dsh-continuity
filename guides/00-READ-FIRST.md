# 00 — 先读这个

这是 dsh-continuity 的经典编号说明书，按顺序读：

```text
01-INSTALL.md
02-TABLES.md
03-AUDIT.md
04-REBUILD.md
05-FIRST-RUN.md
```

版本：4.9.104-safe.1。

## 这一版的前提

```text
每个 session 有自己的完整一套记忆
A/C/K/rules/habits/index 都在 sessions/<sessionId>/ 下
不继承另一个 session 的词表或规则
```

## 路径

```text
~/.dsh/continuity/sessions/<sessionId>/
  bc-index.jsonl
  bc-index-state.json
  audit-state.json
  expand-hint.jsonl
  concepts.md
  cmap.md
  keywords.md
  aliases.md
  rules.md
  habits.md
  rebuild.md
```

共享文件：

```text
~/.dsh/continuity/
  session-persona.json
  personas/<pid>/persona.json
  folds.json
  passes.jsonl
  dropped-ranges.json
  context-log.jsonl
```

`personas/` 已弃用。`persona.json` 只是启用/禁用开关，不决定词表路径。

## 边界

```text
模型工具：workspace + 自己的 sessions/<id>/
不能碰：别人的 continuity 文件
引擎：自己的 session + 全局 folds/passes
guard：best effort，不是 OS ACL
```

不要改 session header 来切 preset。已启动的 session 会返回
`agent-preset/locked`；改 header 可能让 session 从列表消失。

## 新 session

```text
A/C/K 空
rules.md   <- templates/rules.md
habits.md  <- templates/habits.md
index      <- 第一次 pre-step
```

不要复制别的 session 的 A/C/K 来“补齐全”。
