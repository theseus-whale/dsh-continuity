# 发行说明 — 4.9.134-safe.1

## base rules persona-neutral（4.9.134）

撤回 6.7 Creator 入口；根版不再假设存在 Creator。rules-safe 的示例名/示例话题同步去个人化。其余六条与指针说明保留。

## base rules 补 8 条（4.9.133）

新增：确认读取点（四形态）、不可逆先停、卡住装探针、判断独立性、依据/痕迹、存与取、Creator 入口、指针不是缺全文；K-04 注明 preBaselineTokens。保护节后移，确认读取点前置。

## 面板 C 计数 keywords fallback（4.9.132）

bc-panel-state 的 C 计数改为 terms ∪ keywords，与 recall 对齐；cmap 里配置但暂时未命中的条目显示 turns:0，不再消失。

## C 表 keywords fallback（4.9.131）

C 分支不再只认 record.terms；候选集改为 terms ∪ keywords，terms 匹配排序靠前。cmap 写了但 terms 为空的用户词（折叠/流量/线头/重启等）现在能 via C 命中；literal fallback 保持不变。

## drift 判据 0.02（4.9.130）

不再用 |preBaseline−B0|>10%W；改为 |protect_suggested − protect_eff| ≥ 0.02 时一次性 suggestion。长期数据：baseline/surface 中位 0.519；.14 只在 baseline < 142,663 时保证 floor < low，六次采样有三次超过。

## 首次 band-high 校准（4.9.129）

B0 = 首次 band-high 的 preBaseline；protect_eff=clamp((low*W−B0−.01W)/W,.10,.20)，同一 fold 立即用，session 内冻结。calibration 缺失才用 .14。drift >10%W 只给一次 suggestion，不改 policy；clamp .10 且 floor≥low 时同时报 low_min。

## K-04 验收条款（4.9.128）

templates/rules.md 与 guides/03 增加 fold 验收：瞬时值是 provisional，判据用下一次正常 pre-step 的稳定值；protectBinds 用 preBaseline；实际减少量可大于 budget（non-surface 前缀被一并带走）。

## baselinePerNode（4.9.127）

context-log 增加 baselinePerNode = baseline / nodeCount。节点数不变而 baselinePerNode 变 -> 估值/固定开销；两者同步 -> 新节点。文档同时改明：budget 只约束被折的 surface，non-surface 前缀可被一并带走，实际请求减少量可大于 budget。

## baseline nodeCount probe（4.9.126）

context-log 增加 nodeCount / nodeTokenSum / measurementBaseline。若 nodeCount 不变而 baseline 涨，是估值/相位；若 nodeCount 也涨，是新增内容。

## pre-fold baseline 判定（4.9.125）

```text
preBaselineTokens = 触发时 est − surface -> floor/protectBinds
afterBaselineTokens = 折后描述，不参与判定
```

实测 0b：pre 133,272 + .16W 126,812 = floor 260,084；after 263,723 = floor+3,639（切边）。4.9.124 的 context-log 只读白名单仍在。

## context-log 只读白名单（4.9.124）

`read` 可以打开 ~/.dsh/continuity/context-log.jsonl；写入和 shell 仍被拦。用于核对 est/surface/baseline 的相位差。

## 平衡切边的 afterTokens（4.9.123）

`afterTokens` 允许高于 floor；差额来自 tool-pair 对齐的结束边界，实测 +3,639。这是预期行为，不是测量错误。

## 平衡带 0.48/0.32（4.9.122）

```text
high 0.48 · low 0.32 · setpoint 0.48
emergency 0.65 · emergencyTo 0.42
protect 0.14 · maxPerBatch 190k · minAction 24k
```

0b 窗口：high 380k，low 254k，floor 约 244k（baseline 133k + protect .14），一次折约 127k。  
4.9.120 的 protect .30 会把 floor 顶到约 356k，low 到不了，已作废，不要安装。

默认值是启发式，不是保证；真正的判据是每次 fold 的 `afterTokens` 对 `lowTargetTokens`。  
baseline 在折叠前后可能大幅跳变（实测 133,272 → 71,450），所以“baseline 涨了”至少要两个采样点、且跨一次折叠才成立。

## 维护者访问（4.9.118）

```text
C:\Users\35794\.dsh\continuity/operator-sessions.json
```

显式列出的 session 可以跨 session 维护；未列出时仍按 persona/本 session 拦截。没有这个文件时，operator 行为不存在。

## 0.19 压缩带（4.9.117）

```text
high 0.455, low 0.34, protect 0.19, emergency 0.56, emergencyTo 0.36
```

0b 实测 363,543 tokens；新 floor 约 268k，目标约 269k。比 0.18/0.33 多保留约 8k 最近原文，比 0.20/0.35 少约 8k token。

## Token-saver 压缩带（4.9.116）

```text
high 0.455, low 0.34, emergency 0.56, emergencyTo 0.36
protect 0.19, maxPerBatch 140k, minAction 16k
```

0b 实测 363,543 tokens、baseline 117,816；旧 floor 约 355k，新 floor 约 268k。新带宽在 ~361k 触发，一次可把每轮输入向 ~269k 拉。代价是最近原文保护从 30% 降到 19%。

## vec 自检（4.9.115）

```text
guides/06-EMBEDDING.md  说明 pnpm 跳过 onnxruntime-node 时为什么 vec 为空
bin/vec-check.mjs       直接测试本地 embedding 是否返回 512 维有限向量
embedding.mjs           失败时给出 approve-builds/rebuild 提示
```

## 入口指引（4.9.114）

`guides/00-READ-FIRST.md` 现在直接用链接指向 01–05。交付 bundle 文件名会带 `(先读Read-First)`，让接收者先看到入口。

## 说明书改写（4.9.113）

guides/00–05 已从 checklist 改成“步骤 + 为什么 + 不做会怎样 + 如果……则会……”的说明文。
所有命令和路径保留，新增的是解释和失败例子。

## A 表维护（4.9.112）

```text
新 session 的 A 为空 -> B 也为空，这是正常初始状态
A 不会自动生成；需要实例/用户按 rules 维护 concepts.md
rules.md / rules-safe.md 已加入 A 表维护段
已有 session 不会自动重写自己的 rules.md
```

日期：2026-11-03

这一版把每个 session 的完整记忆集都放在本地：
A/C/K、rules、habits、B 索引、审计、提示全部在
`sessions/<sessionId>/` 下。新 session 从空 A/C/K 起，rules/habits 来自
插件根模板，不继承另一个 session 的词表或行为。

## 面板诊断

```text
PANEL.md              明确说明 A/B/C/K 是插件 UI
bin/panel-check.mjs   检查 client.js、dsh.client 和 host route
```

包内已包含 client.js；看不到 tab 时先按 PANEL.md 判断是 client 未加载还是宿主缺少 sidebarRight。

## 稀疏索引审计

`k` 现在上限为实际参与聚类的记录数：

```js
const k = Math.min(points.length, Math.max(20, Math.min(60, Math.round(points.length / 50))));
```

当导入/恢复的索引只有 1–19 条带 vec 的记录时，不再尝试选 20 个不同中心而卡死。
新增测试覆盖 1 / 5 / 19 条记录。

## 审计恢复与输入校验

```text
running:true 带 runningAt；超过 15 分钟视为 stale 并自动恢复
旧状态没有 runningAt 或 JSON null 也按空状态恢复
audit.lock 带 owner token；只释放自己的锁
stale 锁先 rename 到 quarantine，确认 token 后再删
拿到锁后重新检查 200 轮资格
未来 mtime 按 stale 处理
vec 必须是合法 base64、有限数、非零、维度一致
坏 vec 不再推进审计游标
```

新的 gate/peer 过滤同时接受旧 `[闸]` 前缀，避免 legacy notice 被误判；
tag-confirm/engine 的 legacy 选择器也接受 `[gate]/[peer]`。

## 按 session 的 dropped-ranges

`folds.json` 仍按 `sessions/<id>` 分键，`passes.jsonl` 仍保留 `sessionId` 字段；
`dropped-ranges.json` 改为：

```text
sessions/<sessionId>/dropped-ranges.json
```

每个文件只合并本 session 的 folds/passes。全局 `dropped-ranges.json` 不再写入，
因为不同 session 的 seq 空间不同源，合并没有意义。

`appendPassLog` 在写入后按 `pass.sessionId` 重建；宿主启动时也会对已有
passes/folds 做一次按 session 的重建。

## Session 布局

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
  rules.md       <- templates/rules.md
  habits.md      <- templates/habits.md
  rebuild.md
```

`docs/SESSION-LAYOUT.md` 是权威的路径/权限表。

## 守卫

`src/session-guard.mjs` 只检查带路径的参数：

```text
自己的 sessions/<id>/ 和 workspace -> 允许
另一个 session 的 continuity 文件 -> 拒绝
消息/文件正文 -> 不扫描
```

禁用 persona 仍保留普通 workspace 工具，只拒绝 continuity 路径。

这是 best-effort，不是 OS ACL。

## 词表热刷新

`concepts.md` / `cmap.md` 的 mtime 在每次 pre-step 检查；变化会重建该
session 的 labeler/cmap。`keywords.md` 在索引时读取，`aliases.md` 由 recall
每次读取。旧记录不自动重标。

## Preset

已启动的 session 不能切 preset：

```text
agentPresets.select -> agent-preset/locked
```

改 session header 来切 preset 不受支持，可能让 session 从列表消失。
不要这样做。

`standard` 保留原生 `compaction-basic` 80%；没有 continuity band 引擎，也没有
原生 `recall`/`session_log` 工具。

## 空 session 面板

A/B/C/K 四个 section 始终渲染。空表显示明确的空状态，不再整段消失。

## 经典说明

包内恢复经典编号说明：

```text
guides/00-READ-FIRST.md
guides/01-INSTALL.md
guides/02-TABLES.md
guides/03-AUDIT.md
guides/04-REBUILD.md
guides/05-FIRST-RUN.md
```

`04-REBUILD` 是九步重建流程，不是一键迁移；先备份、先 dry-run。
`bin/export-turns.py` 用于导出 turns。

实战状态：

```text
已验证：continuity preset 的 session，有真实历史
未验证：standard preset 的 session
```

## 验收

```text
npm test       exit 0
npm run check  exit 0
```

包内容：插件、全部 `docs/*.md`（现行/历史索引在 `docs/README.md`）、
`guides/00`–`05`、templates、bin、models、client。  
不包含任何 session-specific 工具。
