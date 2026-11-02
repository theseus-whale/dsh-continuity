# 04 — 重建记忆宫殿（九步）

适用于：session 里已有真实历史，但还没有索引/表。
原则：先备份；先 dry-run；不要覆盖已有表。

## 实战状态

```text
已验证：continuity preset 的 session，有真实历史
未验证：standard preset 的 session
```

九步在 continuity preset 上跑通过。  
standard preset 没有原生 recall/session_log，用的是 80% 原生压缩；
那条路仍算未验证。

## 0. 对齐目标

```text
<sessionId> = 精确 session id
<sessionDir> = ~/.dsh/continuity/sessions/<sessionId>/
```

只有 session 自己可以做重建。不要复制别的 session 的 A/C/K。

## 1. 数一遍并备份

```text
bc-index.jsonl 是否存在？多少行？maxTurn？
session.v4.jsonl.zstd 是否还在？
```

写任何东西之前，备份整个 `<sessionDir>` 和原索引。  
失败就回滚。

## 2. 导出 turns

```powershell
python bin\export-turns.py `
  --session-file 'C:\Users\...\session.v4.jsonl.zstd' `
  --session-id '<sessionId>' `
  --out '<sessionDir>\turns.jsonl'
```

输出每行 `{turn,text}`。只含真人 prompt；runtime-context、time-context、
插件注入都会被跳过。

## 3. 建/重标索引

```powershell
node bin\bc-relabel.mjs `
  --index '<sessionDir>\bc-index.jsonl' `
  --turns '<sessionDir>\turns.jsonl' `
  --concepts '<sessionDir>\concepts.md' `
  --out '<sessionDir>\bc-index.relabeled.jsonl'
```

先 dry-run。检查概念数、缺失 turn、输出行数。  
确认后再加 `--write`，重启。

## 4. 补 vec + chatter

```powershell
node bin\bc-relabel.mjs --vectors `
  --index '<sessionDir>\bc-index.jsonl' `
  --turns '<sessionDir>\turns.jsonl' `
  --out '<sessionDir>\bc-index.vec.jsonl' --write
```

新记录通常已有 `vec`/`chatter`；这一步是给旧记录补。  
替换前检查 `vec` 长度（当前 BGE 512）和 `chatter` 0–1。

## 5. 种 K

```text
只收专名：出现 >= 2–3 次、能按名字定位
写入 sessions/<id>/keywords.md，一行一个
```

## 6. 种 A

```text
k = clamp(round(N/50), 20, 60)
簇 size >= 10
topicMax < 0.5
关键词是话题词，不是人名/道具/英文标识
每次最多 +2；总数约 0.6*N
两条覆盖 Jaccard > 0.6 就合并
```

写入：

```text
名字 | 描述词 | 参考覆盖 | kind
kind = topic | workflow
```

不要抄 Continuity 的概念。A 是这个 session 自己的地图。

## 7. 种 C + 别名

```text
cmap.md: 用户词 => B:概念 | K:关键词 | minB:1 | limit:20 | 摘要
aliases.md: 只放跨语言标识符
```

## 8. 用新 A 重标一次

重复第 3 步，让历史轮使用新的 A 表。  
确认旧 `generic` 没有悄悄丢失，行数不变。

## 9. 验收与审计

```text
索引覆盖预期轮次
前几轮 A > 0，B > 0
recall("A标签") 只显示本 session 的概念
C/K 只命中本 session 的文件
没有新的 gate-errors
其他 session 没有被改
```

## 失败规则

```text
没有备份就不覆盖
不写别的 session 的文件
不用改 header 来切 preset
验证失败就恢复并停止
```

A 表为空会跳过审计；这是合法状态，不是重建成功。
