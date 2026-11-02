# 01 — 安装

## 1. 安装

把 tgz 装进目标 DSH profile，备份 `~/.dsh/continuity`，然后重启 DSH。

确认版本：

```text
dsh-continuity 4.9.107-safe.1
```

## 2. 第一次 pre-step 做什么

每个 session 的第一次 pre-step：

```text
1. 解析 session id
2. 检查 persona 是否启用
3. 创建缺失的 session 空壳：
   concepts.md cmap.md keywords.md aliases.md rebuild.md
4. 从 templates/rules.md 种 rules.md
5. 从 templates/habits.md 种 habits.md
6. 第一次索引时创建 bc-index.jsonl
```

只创建缺失文件；已有表绝不覆盖。

## 3. 新 session 是空的

```text
concepts.md 空 -> A 表空 -> B 标签空
```

这是正常的，不是回退失败。

## 4. 历史很长的 session

如果 session 已有很长历史，但还没有索引/表：

```text
先读 04-REBUILD.md
```

不要只从当前 live turn 开始补。

## 5. preset 检查

```text
continuity preset -> band 引擎 + 原生 recall/session_log
standard preset   -> 原生 compaction-basic 80%；没有原生 recall/session_log
```

已启动的 session 不能切 preset。要换 preset，新建 session，不要改 header。

## 6. 重启后自检

```text
1. 版本 = 4.9.107-safe.1
2. sessions/<id>/ 有六个基础文件
3. rules.md / habits.md 在 session 目录
4. 面板显示 A/B/C/K，空表有明确空状态
5. 没有新的 gate-errors
6. 没有改到别的 session
```
