# 重建宫殿（当前布局）

适用：session 已有真实历史（>200 轮），但 continuity 还没有该 session 的索引。
原则：每一步先备份；失败就回滚；不覆盖已有表。

## 1. 数一遍

```text
sessions/<sessionId>/bc-index.jsonl 是否存在？多少行？last turn？
session.v4.jsonl.zstd 是否还在？
导出 turns.jsonl（{turn,text}），与索引 turn 对齐。
```

## 2. 确认 persona

```text
session-persona.json 是否把该 session 映射到 continuity？
没有映射 -> default 是否为 continuity？
词表是否在 sessions/<当前 session>/？
```

不要读全局 `~/.dsh/continuity/concepts.md`；它已归档。

## 3. 建索引

```text
node bin/bc-relabel.mjs --index <session-bc-index.jsonl> \
  --turns <turns.jsonl> \
  --concepts sessions/<当前 session>/concepts.md \
  --out <new-index.jsonl>
```

先 dry-run。通过后加 `--write`，校验行数与键名，备份原索引再替换，重启。

## 4. 补 vec + chatter

```text
node bin/bc-relabel.mjs --vectors \
  --index <session-bc-index.jsonl> \
  --turns <turns.jsonl> \
  --out <vec-index.jsonl> --write
```

- 新记录由 4.9.58+ 自动写 `vec`/`chatter`。
- 旧记录才需要这一步。
- 校验：每行 `vec` 长度正确（当前 BGE 512），`chatter` 0–1。

## 5. 补 K 表

只收专名：出现 ≥2–3 轮、能按名定位的术语。
写入 `sessions/<当前 session>/keywords.md`，一行一个。

## 6. 补 A 表

```text
k = clamp(round(N/50), 20, 60)
```

对 k-means 簇：

```text
size >= 10
topicMax < 0.5
关键词是话题词，不是人名/道具/英文标识符
每次最多 +2；topic 总数约 0.6√N
两条 topic 覆盖 Jaccard >0.6 合并
```

写入 `sessions/<当前 session>/concepts.md`：

```text
名字 | 词1、词2… | 覆盖估算 | kind
kind = topic | workflow
```

- workflow 不参与合并，不占 topic 的 0.6√N 预算。
- 覆盖 >40% 只提示“很宽”，不自动判 workflow；kind 由人判断。

## 7. 用新表重标一次

重复第 3 步，让历史轮使用新 A 表；确认：

```text
recall("A标签") -> 只列 topic
recall("A标签:workflow") -> workflow
recall("跑团") -> 仍走 C，不退回
```

## 8. 补 C 表 + 别名表

```text
sessions/<当前 session>/cmap.md
  跑团 => 跑团叙事 | minB:1

sessions/<当前 session>/aliases.md
  只放跨语言标识符（短信 => sms），不放同义词。
```

## 9. 验收

```text
8 条查询 >= 1 个结果
10 条探针 0 假阳性
recall 打开真实 turn/seq 能对上
A标签 / A标签:workflow 分类正确
```

## 10. 启动审计与回执

```text
写 sessions/<id>/audit-state.json
{"lastAuditTurn": <当前-200>, "nextAuditTurn": <当前>}
```

下一轮自动审计；检查 `sessions/<id>/expand-hint.jsonl` 的 pending/delivered。

折叠发生时检查：

```text
[continuity:fold] 行
passes.jsonl 新行
dropped-ranges.json 是否包含该区间
```

## 11. 最后

```text
floor(T) = (protect * W + baseline(T)) / W
```

baseline 会变；当前值看最新 `context-log.jsonl`，历史 pass 用
`passes.jsonl` 的 `afterBaselineTokens`。不要把 52.7% 当固定下限。

每一步失败都回滚到上一步备份；不要在没备份时替换索引。
