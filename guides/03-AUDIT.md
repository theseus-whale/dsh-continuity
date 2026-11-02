# 03 — 自动审计

## 触发

```text
索引更新后：
if 当前 turn - audit-state.lastAuditTurn >= 200
  -> 后台审计（不阻塞当前轮）
```

审计按 session 独立。`sessions/<id>/audit-state.json` 存游标，
`sessions/<id>/expand-hint.jsonl` 存待注入的提示。

## 输入

```text
bc-index.jsonl 的 vec
bc-index.jsonl 的 chatter
bc-index.jsonl 的 keywords
bc-index.jsonl 的 conceptScores
```

它不重读全部历史。旧记录没有 `vec` 时，先做 rebuild/vector 步骤。

## 候选

```text
k-means k = clamp(round(N/50), 20, 60)
簇 size >= 10
topicMax = 簇内最高概念分的平均
topicMax < 0.5 才算候选
按 topicMax 升序，最多 5 条
```

`chatter` 只展示，不做硬过滤。

## 注入

```text
审计写 pending hint
下一轮 pre-step 以 role=user 注入
标记 delivered 并 unlink
```

只有 session log 里真的出现 `role=user` 才算送达。

## 边界

```text
审计不自动改 concepts
审计不复制别的 session 的 A 表
当前 session 的 A 表为空时跳过审计
```

A 表为空不是审计失败，只是还没有可评分的东西。
