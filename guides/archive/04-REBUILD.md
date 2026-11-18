# 04 — 重建记忆宫殿（九步）

## 先读这一段

重建不是“点一下自动生成一套完美 A 表”。

它是一次**有损的、需要判断的整理**：

```text
从已经存在的历史里
导出文本
重新打一遍标签
再决定哪些东西值得变成 A
```

所以它有三条原则：

```text
先备份
先 dry-run
不覆盖已有表
```

**比如这种情况：**

```text
如果直接对 live index 跑 --write，
而没有备份，
则一次错误的 relabel 就可能把原来的 B 标签覆盖掉。
```

## 实战状态

```text
已验证：continuity preset 的 session，有真实历史
未验证：standard preset 的 session
```

九步在 continuity preset 上跑通过。  
standard preset 没有原生 recall/session_log，只有 80% 原生压缩；那条路仍算未验证。

## 0. 对齐目标

```text
<sessionId> = 精确 session id
<sessionDir> = ~/.dsh/continuity/sessions/<sessionId>/
```

只有 session 自己可以做重建。不要跨 session。

**比如这种情况：**

```text
如果拿 0b 的 concepts.md 去给另一个 session 重建，
则重建出来的不是那个 session 的记忆，只是 0b 的副本。
```

## 1. 数一遍并备份

先回答：

```text
bc-index.jsonl 是否存在？
多少行？
maxTurn 是多少？
session.v4.jsonl.zstd 是否还在？
```

然后把整个 `<sessionDir>` 复制到备份位置。

为什么先数？

因为后面每一步都要拿“行数/轮数”对照。没有基线，就无法判断有没有丢数据。

**比如这种情况：**

```text
如果原 index 有 507 行，
重建后只剩 490 行，
但没有原行数做对照，
则你可能以为只是“少了几个弱轮”，其实是丢了 17 轮。
```

## 2. 导出 turns

```powershell
python bin\export-turns.py `
  --session-file 'C:\Users\...\session.v4.jsonl.zstd' `
  --session-id '<sessionId>' `
  --out '<sessionDir>\turns.jsonl'
```

它只导出真人 prompt：

```text
{ "turn": N, "text": "..." }
```

为什么不能直接拿 `bc-index.jsonl` 当 turns？

因为 index 里只有指针和标签，没有完整用户文本。  
relabel 需要原文才能重新算 B。

**比如这种情况：**

```text
如果 turns 少了几个 turn，
则 relabel 会报 missing turn text，
或者悄悄只处理它能对上的部分。
```

## 3. 建/重标索引

```powershell
node bin\bc-relabel.mjs `
  --index '<sessionDir>\bc-index.jsonl' `
  --turns '<sessionDir>\turns.jsonl' `
  --concepts '<sessionDir>\concepts.md' `
  --out '<sessionDir>\bc-index.relabeled.jsonl'
```

先 dry-run。

它做的是：

```text
读取旧 index
读取 A 表
用 A 给每一轮重新算 conceptScores / generic
写到新文件
不直接覆盖源文件
```

**比如这种情况：**

```text
如果 A 还是空的，
则 relabel 会因为没有概念而无法产生有意义的 B。
```

所以第 3 步之前，至少要先有一个能用的 A 表；  
如果没有，就先做第 6 步的种 A，再回来 relabel。

## 4. 补 vec + chatter

```powershell
node bin\bc-relabel.mjs --vectors `
  --index '<sessionDir>\bc-index.jsonl' `
  --turns '<sessionDir>\turns.jsonl' `
  --out '<sessionDir>\bc-index.vec.jsonl' --write
```

新记录通常已经有 `vec`/`chatter`。  
这一步是给旧记录补。

为什么审计需要 vec？

因为审计要用向量聚类。  
没有 vec，就只剩关键词，候选会很粗。

**比如这种情况：**

```text
如果旧记录没有 vec，
则审计可能跳过，或者聚类结果完全不可用。
```

## 5. 种 K

```text
只收专名：
  出现 >= 2–3 次
  能按名字直接定位
  不是普通动词/泛词
```

写进：

```text
sessions/<id>/keywords.md
```

一行一个。

**比如这种情况：**

```text
如果把“昨天”写进 K，
则每次出现“昨天”都可能被当成精确锚，噪声会变大。
```

## 6. 种 A

这是重建里最需要判断的一步。

大致规则：

```text
k = clamp(round(N/50), 20, 60)
簇大小 >= 10
topicMax < 0.5
名字是话题词，不是人名/道具/英文标识
每次最多 +2；总数约 0.6*N
两条覆盖 Jaccard > 0.6 就合并
```

写入：

```text
名字 | 描述词 | 参考覆盖 | kind
kind = topic | workflow
```

为什么要限制数量？

因为 A 不是越多越好。  
太多、太碎，B 标签会变得没有区分度；  
太少、太宽，B 又会把所有轮都归到同一个概念。

**比如这种情况：**

```text
如果 A 只有“工作”和“生活”两个概念，
则 B 几乎每轮都会落在这两个上，等于没有标签。
```

```text
如果 A 有 200 个近义概念，
则同一轮可能被拆到很多小标签里，也失去区分度。
```

## 7. 种 C + 别名

```text
cmap.md:
  用户词 => B:概念 | K:关键词 | minB:1 | limit:20 | 摘要

aliases.md:
  只放跨语言标识符
```

为什么 C 不是 A？

A 是“话题叫什么”，C 是“用户怎么称呼它”。

**比如这种情况：**

```text
如果用户一直说“换箍”，
而 A 里叫“示例主题”，
则没有 C 的桥接，recall("换箍") 很难稳定命中。
```

## 8. 用新 A 重标一次

重复第 3 步。

为什么？

因为第 3 步可能是在 A 还不完整时跑的。  
新 A 建好后，历史轮需要重新用新 A 打分。

**比如这种情况：**

```text
如果 A 加完了但不重标，
则历史轮的 B 仍然是用旧 A / 空 A 算出来的。
```

## 9. 验收与审计

```text
index 行数覆盖预期轮次
前几轮 A > 0，B > 0
recall("A标签") 只显示本 session 的概念
C/K 只命中本 session 的文件
没有新的 gate-errors
其他 session 没有被改
```

**比如这种情况：**

```text
如果 index 行数对，但 B 全是 weak，
则可能 A 太宽，或者 relabel 用的 concepts.md 不是最新的。
```

## 失败规则

```text
没有备份就不覆盖
不写别的 session 的文件
不用改 header 来切 preset
验证失败就恢复并停止
```

重建不是“跑完就算成功”。

真正的成功是：

```text
数据对得上
B 有区分度
原文还能打开
没有污染别的 session
```
