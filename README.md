# dsh-continuity 4.12.8

## 4.12.8 T/TAG 与 turnGate 清理

彻底删除 T/TAG header、打标提醒、tag-debt 写入、turn-stopping 注册与 turnGate 配置。`autoTagCompletedTurn` 也删除，不再自动写 turn-tags；旧 turn-tags 仅只读兼容。说明书不再提 T/TAG。

rules/habits carrier 在重启后扫描 surface 中的全文消息；发现多份时保留最早一份，其余原位清空，避免重启一次多一份。

## 4.12.6 rules/habits 全文保持一份最新

4.12.5 已发布，不能覆盖；4.12.6 承载 rules 全文修复。

## 4.12.5 A 锚的 onboarding

onboarding 与 base-rules 明确：A 表不自动生成，也不自动增长；每轮系统会做 B 标注，但 A 空时 B 只会是 weak。实例识别出新话题时，需要手动往 `concepts.md` 追加一行。

没有新增一次性提醒机制；A 的行为由 rules 承担。

rules/habits 全文：`pointersOnly: false`。carrier 仍在 surface 时内容变化用 `surfaceOp: replace` 原位换掉；carrier 被 fold 走才 append；hash 不变不注入。

> Band (config-only) 已从生产菜单移除；不再提供 `band` preset，只保留内部 baseline 代码。

## 4.12.4 Continuity 默认 PTC

`continuity` 保留原 id，composition 改为原生 `@deepseek-ai/dsh-tool-executor-ptc`。
`continuity-ptc` 只保留为临时别名，等已有会话切回 `continuity` 后删除。

```text
continuity       -> PTC（新会话默认）
continuity-ptc   -> 过渡别名，内容相同
```

已验证：`run_code` 可调用 `ptc_handoff`、`session_log`、`child_asset`；asset 复制与取回正常。

## 4.12.3 修复 DSH 0.2.2 preset broken

DSH 0.2.2 不再提供 `@deepseek-ai/dsh-tool-subagent-control/list-agents` 子路径。4.12.3 从 `preset-band` 和 `preset-continuity` 移除 `tool-subagent-list-agents` 行，保留主 `tool-subagent-control`。

否则 preset 会被标记为：

```text
broken: tool-subagent-list-agents ... never started
```

模式菜单不显示 Continuity，已有 continuity session 也无法载入。

给 DSH 的长上下文连续性插件。每个 session 拥有自己完整的一套记忆；
persona 只是身份/启用标签。

```text
session  = 哪一段对话
persona  = 哪个身份被允许运行（启用开关）
```

## 它做什么

```text
compaction      压缩带控制；session 内 pass 回执 + passes.jsonl
index           每个完成的人类轮次一条指针
A               每个 session 自己的概念表，分 topic / workflow
B               每轮标签（展示、特征材料）
C               每个 session 自己的用户词表
K               每个 session 自己的精确名
rules/habits    每个 session 自己的规则/偏好，从插件根模板起
recall          A / B / C / K + 字面，只查当前 session
panel           每个 session 自己的 A/B/C/K
peer_message    明确投递给另一个 live session
```

不包含额外的提示词分类或自动标注；本包只负责记忆索引、压缩和检索。

## 每个 session 的完整一套

```text
~/.dsh/continuity/sessions/<sessionId>/
  bc-index.jsonl
  bc-index-state.json
  audit-state.json
  expand-hint.jsonl
  concepts.md      A 表（名字 | 描述词 | 覆盖 | kind）
  cmap.md          C 表
  keywords.md      K 表
  aliases.md       别名
  rules.md         硬规则，从 templates/rules.md 起
  habits.md        软偏好，从 templates/habits.md 起
  rebuild.md       本地重建说明
  dropped-ranges.json  本 session 的合并覆盖（seq 空间只属于本 session）
```

共享/诊断：

```text
~/.dsh/continuity/
  session-persona.json        sessionId -> 身份
  personas/<pid>/persona.json {"enabled": true}
  folds.json
  passes.jsonl
  context-log.jsonl
```

- A/C/K/rules/habits **不继承**另一个 session。
- 新 session：A/C/K 空，rules/habits 从插件根模板起。
- `personas/` 是弃用归档，已经不是读取路径。
- `session-persona.json` 只决定身份/启用，不决定词表路径。

## 安装

```text
dsh-continuity-4.12.2.tgz
```

装进目标 profile，备份 `~/.dsh/continuity`，重启 DSH。  
进程是快照：只复制包不重启，运行时行为不变。

## 4.12.2 水位恢复

4.12.2 = 4.12.0 的水位线 + `maxPerBatch = high−protect`；**native LLM summary 保留，不启用 mechanical note。**

```text
setpoint .76
high     .76
low      .38
emergency .85 -> .62
protect  .20
maxPerBatch 443843
mechanicalNote false
```

`protectCalibration` 不再显式关闭，回到 4.12.0 的默认行为。

`maxPerBatch 443843` 覆盖 high-protect 的 `443,842.56`：  
实际 budget 仍是 `min(est − low, maxPerBatch)`，正常高线折约 301k，overshoot 不被 cap 截成二次小折。

`recall_exact` / `recall` / ABCK / gist / history-map 都不动。  
4.13.x 的 mechanical note 只保留为实验代码，4.12.2 不启用。

## 4.12.0 新增

### recall_exact

字面搜索，独立于 `recall` 的语义路径；只读、不排序、不写。

```text
recall_exact({ query: "0.2.17" })
recall_exact({ query: "stage19", since: 2200 })
recall_exact({ query: "coo-read-side", near: 2300, window: 20 })
```

规则：

```text
只搜 user + assistant 的 text
不搜 reasoning / tool-call
排除 continuity / 规则 / 系统注入文本
ASCII 用 [0-9A-Za-z] 边界；中文按子串
单个中文字必须白名单（目前只放“创”）
返回 totalTurns / totalIntervals / shown / turnShare
```

没有 path 参数；只查当前 session。

### native summary 是默认中间层

fold 仍由 DSH 原生 compaction 完成：

```text
系统选段 -> LLM 写 checkpoint -> replace 原区间
旧 summary 下次折入新 summary
```

`history-map` 默认关闭：

```text
默认不注入 map
默认中间层就是 native checkpoint
auto / observe 只作实验档
```

需要时看 `docs/history-map.md`。

### summary-index / window 工具

```bash
# 建当前 session 的摘要索引
node bin/summary-index.mjs --raw <session.v4.jsonl.zstd> \
  --session-dir <continuity session dir> --apply

# 有 pending window 时生成抽取式摘要
node bin/summary-index.mjs ... --extract-pending --apply
```

默认不自动跑；`pendingWindows=0` 时不需要。

## recall

```text
recall()
recall({ query: "跑团", recent: true })
recall({ query: "A标签" })                 // 只看 topic
recall({ query: "A标签:topic" })
recall({ query: "A标签:workflow" })
recall({ query: "A标签:跑团叙事" })         // 任意 A 概念
recall({ query: "B标签" })
recall({ query: "C标签" })
recall({ query: "K标签" })
```

- 索引和 A/C/K 只读当前 session 的目录。
- A 直接查是“区域浏览”；B/C/K/字面是“精确点位”。
- `via` 是 `A | B | C | K | live`。
- 候选不是事实；必须打开对应 turn/seq。

### 词表刷新

- `concepts.md` / `cmap.md` 的 mtime 会在下一次 pre-step 检查，变了就重建本 session 的 labeler/cmap；不需要重启。
- `keywords.md` 在索引时读取，下一轮生效。
- `aliases.md` 由 recall 每次读取。
- 旧记录不会自动重标；新规则只作用于新轮次。

## 注入前缀

```text
[continuity:boot]    引导
[continuity:audit]   审计
[continuity:fold]    压缩回执
```

插件注入的 `role=user` 消息都以 `[continuity:*]` 开头。  
`[追忆]` 是 recall 的 tool result，不是 user 通道注入。

## rules 头部

`rules.md` 按 H2 标题汇总。截断时写：

```text
…（共 18 节，仅显示前 13 节）
```

数字从当前文件现算，不硬编码。

## session 启用 / 面板

```text
session-persona.json:
  <sessionId> -> continuity | <pid>
  default -> continuity

personas/<pid>/persona.json:
  {"enabled": true} -> 面板 + pre-step 启用
  缺失/禁用          -> persona-disabled，关闭 tab
```

`continuity` 在旧安装里没文件也默认启用。  
非 continuity session 也可以启用，但它的 A/C/K/rules/habits 仍然是
session-local，不继承 Continuity 的。

## 隔离边界

插件路径是 session-local。宿主还装了一个 best-effort 工具守卫：
session 只能碰自己的 `sessions/<id>/`，不能碰别的 session 的 continuity 文件。

这**不是 OS 安全边界**。拥有完整文件权限的任意代码可以绕过；强隔离需要
OS ACL/容器。守卫用于普通 edit/write/shell 工具。

## 标签版本

新记录用 `labelVersion: 2`：

```text
genericTopic      [top topic]
topicScore        top topic 分数
topicConfidence   normal | low | weak（仅展示）
genericWorkflow   [top1, top2]
generic           topic + workflow 并集
conceptScores     选中的候选分数
```

旧记录是 `labelVersion: 1`，没有 `topicScore`；不原地回填。

## 代码地图

```text
src/index.mjs                 宿主路由、面板 JSON、安装
src/engine.mjs                压缩带、pass 回执、gist/fold
src/state.mjs                 pass log、dropped-ranges
src/policy.mjs                压缩带数学与 floor
src/recall-tool.mjs           A/B/C/K 检索，session 路径
src/memory/bc-pre-step.mjs    每 session 调度
src/memory/bc-index.mjs       JSONL 指针编解码
src/memory/bc-index-updater.mjs 标签 + 追加一轮
src/memory/bc-panel-state.mjs 面板投影
src/memory/concepts-file.mjs  A 解析（kind: topic|workflow）
src/memory/persona.mjs        session -> 身份/路径
src/memory/onboarding.mjs     boot marker/空壳
src/memory/bc-audit.mjs       审计 + 待注入提示
src/threads-store.mjs         每 session rules/habits
src/folds-store.mjs           folds.json 历史
src/session-guard.mjs         best-effort 工具路径守卫
client.js                     右侧面板
cordis.patch.yml              bundle patch
```

## 文档

```text
README.md                     本文件
RELEASE-NOTES.md              验收状态与已知限制
PANEL.md                      面板排错与诊断
bin/panel-check.mjs           面板/宿主路由自检
docs/README.md                现行/历史文档索引
docs/SESSION-LAYOUT.md        权威路径、角色、权限
docs/ARCHITECTURE.md          当前架构
docs/NEW-INSTANCE-HANDOFF.md  新实例交接
guides/00-READ-FIRST.md       经典 00–07 说明书
guides/01-INSTALL.md
guides/02-TABLES.md
guides/03-AUDIT.md
guides/04-REBUILD.md          九步重建
guides/05-FIRST-RUN.md
guides/06-EMBEDDING.md        本地嵌入
guides/07-PTC-AND-ASSETS.md  PTC / 子 agent / assets
templates/rebuild.md          当前布局的重建流程
```

`docs/*.md` 全部随包发布；`docs/README.md` 区分现行与历史。  
历史文档是设计档案，不是现行操作说明。

## 安全

不要从 session 内修改已安装的插件、`cordis.patch.yml`、package 文件或
lockfile。插件变更走独立副本、测试、备份、替换。
