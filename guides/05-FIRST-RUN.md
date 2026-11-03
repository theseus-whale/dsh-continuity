# 05 — 第一次运行

按顺序做，别跳。

## 0. 确认是新 session

```text
没有本地的 bc-index.jsonl
没有本地的 concepts.md / cmap.md / keywords.md
```

新 session 不能带着别人的表启动。

## 1. 安装并重启

安装 tgz，重启 DSH，确认版本 `4.9.111-safe.1`。

## 2. 确认首次启动

```text
sessions/<id>/ 出现基础文件
rules.md / habits.md 来自 templates/
第一次 pre-step 后出现 index
[continuity:boot] 只出现一次
```

如果 boot 反复出现，先看 `gate-errors`；不要手写 `done` 掩盖。

## 3. 确认空表行为

```text
concepts.md 空 -> B 标签空；这是正常的
不会回退到别的 session 的表
面板显示 A/B/C/K 空状态
```

正常聊天，积累语料。

## 4. 前 200 轮

```text
需要回忆时用 recall(query)，给精确词
重要结论写进本 session 的文件或工作区 log
不要手动排审计
```

## 5. 第一次审计

```text
到 200 轮，可能出现 [continuity:audit]
多数叙事簇是噪声；不是真话题就跳过
真要加，再写 concepts.md
```

## 6. 有历史就重建

如果 session 已有很长历史，不要从当前 live turn 开始。
先读 `04-REBUILD.md`，备份、导出 turns、建索引。

## 7. 验收

```text
A/B/C/K 文件存在且只属于本 session
recall 使用本 session 的索引
没有改到别的 session
没有新的 gate-errors
```
