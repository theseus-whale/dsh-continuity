# Continuity 4.11.25 — 新实例交接

> 给下一个实例。你接手的是当前 session 的目录、规则和词表，不是另一个
> session 的记忆。先读这份，再读当前 session 的 `rules.md` / `habits.md`。

## 1. 版本与边界

```text
dsh-continuity 4.11.25
安全模式：pointersOnly；peer 保留
不包含：额外的提示词分类、自动标注或工作线注入。
```

它做：

```text
band 压缩 + [gist] 指针
每个 session 自己的 B 索引
每个 session 自己的 A/C/K
每个 session 自己的 rules/habits
recall(A/B/C/K + 字面)
右侧面板 + peer_message
```

## 2. 每个 session 自己的全套

```text
~/.dsh/continuity/sessions/<sessionId>/
  bc-index.jsonl
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

新 session：

```text
A/C/K = 空
rules.md   <- 插件 templates/rules.md
habits.md  <- 插件 templates/habits.md
```

不继承另一个 session 的 A/C/K 或 rules/habits。

persona 只是身份/启用开关：

```text
session-persona.json:
  <sessionId> -> continuity | <pid>
  default -> continuity

personas/<pid>/persona.json:
  {"enabled": true}
```

`continuity` 没文件也默认启用；disabled persona 会被 pre-step 跳过，面板
返回 `persona-disabled`。

## 3. 当前文件

```text
sessions/<id>/bc-index.jsonl
sessions/<id>/audit-state.json
sessions/<id>/expand-hint.jsonl
sessions/<id>/concepts.md
sessions/<id>/cmap.md
sessions/<id>/keywords.md
sessions/<id>/aliases.md
sessions/<id>/rules.md
sessions/<id>/habits.md
sessions/<id>/dropped-ranges.json

~/.dsh/continuity/
  session-persona.json
  personas/<pid>/persona.json
  folds.json
  passes.jsonl
  context-log.jsonl
```

## 4. 检索

```text
recall()
recall({ query: "跑团", recent: true })
recall({ query: "A标签" })           // 当前 session 的 topic
recall({ query: "A标签:workflow" })  // 当前 session 的 workflow
recall({ query: "A标签:示例主题" })   // 任意 A 概念
recall({ query: "B标签" })
recall({ query: "C标签" })
recall({ query: "K标签" })
```

- 索引和 A/C/K 只读当前 session。
- `via`：`A | B | C | K | live`。
- 候选不是事实，必须打开 turn/seq。

## 5. 注入前缀

```text
[continuity:boot]    引导
[continuity:audit]   审计
[continuity:fold]    折叠回执
```

`[追忆]` 是 recall 的 tool result，不是 user 通道注入。

## 6. 压缩与回执

```text
high 0.60W 触发
low 0.40W 目标
protect 0.30W
一次 pass 折一个最老连续区
budget 是上限，不是必然排干
```

可达下限：

```text
floor(T) = (protect * W + baseline(T)) / W
```

baseline 会变；当前值看最新 `context-log.jsonl`，历史 pass 用
`passes.jsonl` 的 `afterBaselineTokens`。不要把 52.7% 当固定值。

## 7. 标签版本

```text
v2（新轮）:
  genericTopic / topicScore / topicConfidence / genericWorkflow
  labelVersion: 2
  generic = topic ∪ workflow

v1（旧轮）:
  labelVersion: 1
  无 topicScore，不伪造
```

`topicConfidence` 的 0.4/0.5 只是展示标签，不是写入阈值。

## 8. 启动自检

```text
1. 当前 session 的 persona enabled
2. sessions/<id>/bc-index.jsonl 存在
3. bc.json?sessionId=<id> 返回 available
4. A标签 -> 当前 session 自己的 topic
5. C/K 查询只命中当前 session 自己的表
6. 另一 session 的目录不被本 session 修改
7. 没有新增 gate-errors
```

## 9. 规则层级

```text
AGENTS.md        用户所有；实例不改
sessions/<id>/rules.md    当前 session 硬规则；可改
sessions/<id>/habits.md   当前 session 软偏好；可改
sessions/<id>/concepts.md|cmap.md|keywords.md|aliases.md  当前 session 数据
```

`rules.md` 只能规定当前 session 的这些文件；不能授权改插件或别的 session。

## 10. 保护

```text
不改 live profile 的 dsh-continuity 安装目录
不改 cordis.patch.yml / package.json / lockfile / tgz
```

插件变更只能走：

```text
独立副本 -> 测试 -> 备份 -> 替换 -> 重启 -> 验证
```

工具层有 best-effort 路径守卫：session 只能碰自己的 `sessions/<id>/`。
它不是 OS 安全边界；强隔离需要 ACL/容器。

## 11. 常见故障

```text
没有 tab
-> personas/<pid>/persona.json 是否 enabled
-> bc.json 是否 persona-disabled

A标签 是 0
-> sessions/<id>/concepts.md 是否存在/为空
-> 第 4 列 kind 是否存在

recall 空
-> sessions/<id>/bc-index.jsonl 是否存在
-> C/K 是否在当前 session 目录

rules 没更新
-> 是否改的是当前 session 的 rules.md，而不是旧的全局文件

另一 session 被改
-> 工具层守卫只能挡常规工具；检查 ACL
```

## 12. 原则

```text
每个 session 自己的全套。
候选不是事实。
[gist] 不是原文。
A 默认只看 topic。
pass 回执 append-only。
可达下限由 protect + baseline 现算。
工具守卫不是 OS 安全边界。
```
