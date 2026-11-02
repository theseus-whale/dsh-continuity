# 02 — A / B / C / K

四张表全部是 **每个 session 自己的**。任何一张都不回退到别的 session。

## A — 概念表

文件：

```text
sessions/<sessionId>/concepts.md
```

格式：

```text
名字 | 描述词 | 参考覆盖 | kind
kind = topic | workflow   （默认 topic）
```

用途：

```text
面板展示
B 打标签的候选
C 的 minB 评分
审计的 topicMax
```

A 不直接参与找回。真正找回靠 B/C/K/字面。

## B — 每轮标签

存在：

```text
sessions/<sessionId>/bc-index.jsonl
```

新记录：

```text
genericTopic      [top topic]
topicScore        top topic 分数
topicConfidence   normal | low | weak   （仅展示）
genericWorkflow   [top1, top2]
generic           topic + workflow 并集
conceptScores     选中的候选分数
labelVersion      2
```

旧记录是 `labelVersion: 1`，没有 `topicScore`，不原地伪造。

B 是展示/特征材料，不是 A 浏览。“weak” 是置信度信号，不是索引失败。

## C — 用户词

文件：

```text
sessions/<sessionId>/cmap.md
```

格式：

```text
词 => B:概念 | K:关键词 | minB:1 | limit:20 | 摘要
```

C 把用户说法映射到概念/关键词，只属于当前 session。

## K — 精确名

文件：

```text
sessions/<sessionId>/keywords.md
```

一行一个精确名字。用于专名、标识符、游戏名、人名、必须字面命中的术语。

## 别名

文件：

```text
sessions/<sessionId>/aliases.md
```

只放跨语言标识符，不放同义词。

## 空是合法状态

```text
A 空 -> B 空
K/C 空 -> 没有 C/K 命中
```

不要用别的 session 的表来“修好”新 session。
