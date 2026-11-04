# 发行说明 — 4.11.20

## topicMinScore 持久化（4.11.20）

toPointer 之前漏了 topicMinScore，导致 labeler/updater 有值但写盘被过滤。现已加入 pointer，测试覆盖 roundtrip。旧行不回填，需 relabel 时补。

## relabel 只读演练（4.11.20）

bin/relabel-dry-run.mjs 进包；只读，不写 index/baseline/raw；LOO 样本 <100 时输出显式警告；raw 缺失轮记 unresolved。

## eval baseline 缺失修复（4.11.20）

eval-label-rules 把缺失 baseline 记为 NaN 而非 0，再以已知 topic 全局均值回填；空 baseline 则 raw-bootstrap。输入与 baseline 读取去 BOM。避免缺失项 centered=raw 通吃。

## baseline 缺失回退（4.11.20）

baseline 里没有的 topic 用 session 全局均值回退，不记 0；没有任何 baseline 样本时按 raw bootstrap、不做居中。避免新增 topic 因 0 基线获得偏置。eval-label-rules 同步。

## 评估脚本与 concepts 模板（4.11.20）

bin/eval-label-rules.mjs 随包发布；--baseline-file 同时接受扁平 {topic:mean} 和 {version,window,samples:{topic:[...]}}。private files 补 templates/concepts.md。

## topic baseline 居中（4.11.20）

bc-index-updater 新增 per-session bc-topic-baseline.json：记录最近 300 轮所有 topic raw score，centered=raw-滚动均值；判据 centered>=.02 且领先>=.02，否则 topic:[]；当前轮不参与自己的 baseline，标完再更新。D 方案。

## A 表描述写法（4.11.20）

根 rules / rules-safe 增加：A 表描述用一句短句 + 4–6 个具体名词；具体名词优先于抽象词；改描述或加 topic 后用同一批 ≥30 轮固定样本复核 top-1/top-2/空值/margin，不达标回退。

## 用户输入补 turn / 去 reasoning（4.11.20）

bc-index-updater 从 turn/start、step/start 建 seq→turn 映射，给没有 data.turn 的 user/message 补 turn；打标文本只用 includeReasoning:false；同 turn 内用户在前、助手在后。修复 31 条样本 userChars=0、reasoning 占正文的问题。

## 分块打标 + 相对间隔（4.11.20）

bc-label 增加 labelChunked：600 字一块，最多 12 块，逐块算 concept 最高分；topic 需 >= topicMinScore 且领先第二名 >= topicMargin(.03)，否则 topic:[]。bc-index-updater 改用 labelChunked；长轮次不再只按开头打分。

## topicMinScore（4.11.20）

bc-label 增加 topicMinScore 默认 0.33；topic 低于阈值返回空数组，不再 score>0 必选。topicMinScore 写入记录，便于一致率统计。topic 为空时 recall A标签/面板安全。

## workflow childSessionId 硬约束（4.11.20）

workflow 最终 return 不回传 childSessionId；必须让子读 DSH_SESSION_ID 并写入回执。subagent 至少给启动 agentId，workflow 连这个都没有。根规则、rules-safe、guide 07 已同步。

## PTC unresolved 细节（4.11.20）

guide 07 与根规则补上 unresolvedArtifacts 的实际形状 {source, reason:"not-a-file"}，以及 artifactsResolved=false；避免新鱼以为 unresolved 是字符串。

## 指南编号修正（4.11.20）

06-EMBEDDING.md 已占用 06；PTC/子 agent/assets 指南改为 07-PTC-AND-ASSETS.md，README/00-READ-FIRST 同步。

## PTC / 子 agent / assets 说明书（4.11.20）

新增 guides/07-PTC-AND-ASSETS.md；根版 rules.md / rules-safe.md 增加 PTC/子 agent/assets 节：父 canonical、子用 DSH_SESSION_ID、ptc_handoff 回执与 artifact 复制、session_asset/child_asset 分工、大结果落 assets、旧 mime/seq 容忍、不要 backup→compact→restore 验资产。

## artifactSources mime（4.11.20）

ptc_handoff 的 artifactSources 每条现在带 mime，离线读 handoff.json 就能知道 png=image/png、txt=text/plain。

## PTC artifact mime/seq（4.11.20）

复制品按扩展名补 mime（png->image/png，txt->text/plain，json->application/json）。同一 handoff 内 handoff=baseSeq，artifacts=baseSeq+1..N，不再全部 seq=0，child_asset get 可按 seq 定位每个 artifact。

## PTC artifact 实体化（4.11.20）

ptc_handoff 不再只把 artifact 路径写进 envelope。存在的文件会复制到 assets/ptc/<run>/<child>/，带 sha256/bytes，envelope.artifacts 改为已注册相对路径；缺失文件记入 unresolvedArtifacts，artifactsResolved=false，不制造悬空指针。

## attachmentId 解析与父图恢复（4.11.20）

用户上传图片常以 attachmentId 存在，只有 name/mediaType/bytes，没有 path/data。assets 现在解析 .dsh/attachments/v1/objects/<sha>，写入 payload；session_asset get 对已折叠的 parent seq 也能从 raw session 现场恢复。已确认 seq 78456 的附件对象存在（422135 B）。

## 路径图片 + header=false 资产指针（4.11.20）

materializeRangeAssets / nonTextInfo 识别 data.content、data.summary、data.message.content；用户上传图片不再漏扫。provenance.header=false 时仍写入 asset-only 指针，避免资产落盘但不可见。

## 路径图片字节补全（4.11.20）

read_image 这类只给 name/path 的 image block，bytes 以前为 null，被 4MiB 闸当成非图片而换成 handle。现在 bytes 未知时用 fs.statSync(path).size 补全；仍超过 4MiB 才回 handle。

## Assets + PTC handoff（4.11.20）

新增 sessions/<id>/assets：fold 前把 image/file/audio/video 原样落盘，并写 index.jsonl。session_log 标记 [asset-parent ...]；session_asset 取父资产；child_asset 取 PTC child artifact，并在 child session 仍可读时现场恢复未注册图片；ptc_handoff 把 child envelope 写成父可见 artifact。工具当前返回路径与元数据，不直接返回 image block。

## 图片尺寸闸（4.11.20）

MAX_INLINE_IMAGE_BYTES = 4 MiB。图片 bytes（attachment.size 或 base64 长度折算）≤4MiB 才保留；超过则回到 non-text handle 并保留原因。这样不依赖宿主 tokenMeter 对 image 的估算。

## 图片结果保留（4.11.20）

handleNonTextResults 跳过 image 工具结果；图片不再被替换成 text handle，直接进入模型上下文。file/audio/video 仍走原来的 handle。图片会占 context token，可能触发更高水位或 overflow；这是保留图片的代价。

## coo/peer 双角色兼容（4.11.20）

load-gate / event-alias-ledger / referent-ledger 同时接受 role/source 的 coo 与 peer；public 版不再把 coo 替换成 peer。pet bridge 传 coo 时行为保留，公共包仍保持 peer 命名。special keywords 默认空是 public 的故意隐私默认，K 表不受影响。

## 4.11.20 修正（4.10.0 作废）

4.10.0 的 public 包从 `publish/dsh-continuity-public` 打出，但该树 `src/engine.mjs` 仍是旧的 `warnOnce`（仍写 lastError）。4.11.20 已把 dev 的 engine 同步进 public 并重新打包。逐文件哈希：engine `8081CF81B0EC` 两侧一致；其余 14 个 src 差异为既有的 public 去个人化差异，不是行为漂移。

## Stable 首版（4.11.20）

相对 4.9.136：

```text
C 表 recall / 面板同时支持 terms ∪ keywords；turns:0 的 cmap 条目可见
首次 band-high 做 protect 校准（protect_source=calibration / protect_eff / B0）
drift 用 protect 距离 0.02 判定；afterTokens 只作 provisional
K-04 用 preBaselineTokens；budget 只约束被折的 surface
根版 rules 6.x：确认读取点 / 不可逆先停 / 探针 / 独立性 / 依据 / 存取 / 指针说明
warnOnce 不再写 lastError；tags.json 缺失只记 warn
```

安装见 `INSTALL.md` 或 `guides/01-INSTALL.md`。

## 根版四处收口（4.9.136）

§7 可改清单加 concepts.md / aliases.md；§3 写明 K/C 与 A 同路径 session 目录；§10 明确 ±3% × low×W；§9 peer_message 视为安装依赖而非必过。

## 读数来源五处修正（4.9.135）

rules.md：追忆点明 session_log get；K 立即生效、C/A 需 recall 工具重建；自检用当前 Web 端口；fold 稳定值读 state/context-log 的 context.estTokens；low/W 读 engine.policy.low 与 context.windowTokens。删除不存在的 nextRequest 字段。

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
