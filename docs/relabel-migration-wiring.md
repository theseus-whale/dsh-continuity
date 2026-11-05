# 历史重标迁移：接线方案（v3，已上线 4.11.33）

状态：**已在 4.11.33 上线并按设计跑完一次真实迁移**（2026-11-05 10:29:35 → 10:33:06）。
下文的"待复核"已是历史；实测结果见 §13。

v2 变更：① 补 per-session 写互斥 ② apply 改为 all-or-nothing ③ 新增"要不要重扫"的打分与 `labelStamp` 增量方案。
v3 变更：④ `conceptsFile` 必须取 session 词表（`sessionFile(sessionId,'concepts.md')`），不能用 persona/global 回退 ⑤ 覆盖前置检查 ⑥ 实测数据。

## 0. 目标与非目标

目标：
- 放 `bc-index.relabel-pending.json` 后，下次启动自动完成历史重标（只改 topic 四字段）
- **任何时刻不出现"迁移写盘"与"updater 追加写盘"互相覆盖**
- apply 失败 = 原文件零改动（all-or-nothing）
- 默认不做全量：用 `labelStamp` 让"重扫"变成事件而不是习惯

非目标：
- 不改 workflow / 不改 raw / 不自动建 marker / 不自动调阈值

## 1. 现有结构（读代码结论）

`bc-pre-step.mjs` `installBCPreStep` 的 session 作用域分支：

```
const bySession = new Map();
const getSession = (sessionId) => {          // 同步
  entry = makeStep(indexFile, sessionId);    // loadIndexJsonl + createBLabeler + createIndexUpdater
};
ctx.on('agent/pre-step', async (payload, next) => {
  const entry = getSession(payload?.agent?.session?.id);
  return entry.step(payload, next);
});
```

- `createIndexUpdater` 写盘是**整文件重写**：`saveIndexJsonl(file, [...records, ...added])`
- `records` 是 `makeStep` 时读进内存 → 任何外部改写都会被下一次写盘覆盖（已实证：重标期间 live 追加 3 行）
- updater 内部有 `running` 标志（`if (running || ...) return`），但**没有对外的"等它写完"接口**

## 2. 迁移模型：后台跑 + pre-step 暂停索引 + **每 session 写互斥**

```
① pre-step 首次遇到某 session 且 marker 在
   → 启动后台迁移；sessionId 进 relabelling 集合
② pre-step 发现 session ∈ relabelling → 直接 next()（不打标、不写盘）
③ 迁移完成/失败 → relabelling.delete + bySession.delete
   → 下次 pre-step 重建 entry，从磁盘重读 records
④ 迁移窗口内的新轮次：stateFile 的 afterSeq 会在恢复后自动补齐
```

### 2.1 写互斥（两条都要，缺一不可）

**互斥 A：迁移启动前，等当前 updater 写完**

```
updateIndex 增加 whenIdle(): Promise<void>
  · **保存当前 running 的 promise**（不是只看 bool；bool 在 promise 刚结束的窗口里不可靠）
  · running 为真 → 返回那个 promise；否则立即 resolve
迁移第一步：await updateIndex.whenIdle()
```

理由：`relabelling` 集合是"从现在起忽略新的 pre-step"，但**已经跑在途中的那一次 step 仍然会写盘**。
不 await 它，迁移可能刚写完就被那一次 step 的 `records`（旧标签）整文件覆盖。

**互斥 B：updater 每次 save 前检查"没人正在迁移"**

```
共享 gate（同一 store 对象内）：
  { relabelling: Set<sessionId>, lockOwned: boolean }
updater step 内，saveIndexJsonl 之前：
  if (gate.relabelling.has(sessionId)) → 放弃本次写
  if (gate.lockOwned) → 同上（另一个进程/本进程在迁移）
```

**放弃写盘时必须遵守两条（创 2026-11-04 补充）：**

```
① 不推进 stateFile 的 lastSeq / afterSeq
② added 留在"待重试队列"（内存 pending），下一次 step 先合并再写
```

否则被 gate 挡掉的那几轮**永远不会再被处理**（lastSeq 已前移，updater 认为已同步）。
即在 gate 路径里：`pending.push(...added)` + `return`，**不要**调用 `saveState`。

理由：互斥 A 只挡住"迁移开始那一刻"；迁移进行中若有**非 pre-step 路径**触发了写盘（例如手动 tools 或第二个入口），B 是最后一道闸。
**A 与 B 同时存在**：A 保证顺序，B 保证事后，且 B 必须"挡得住且不丢数据"。

### 2.2 锁（跨进程）

```
文件：<sessionDir>/bc-index.lock   内容：{ pid, startedAt, host }
获取：fs.open(lock, 'wx') 成功即持有；EEXIST 时读 startedAt
  · 超过 90 分钟 → 视为过期，覆盖 + warn
  · 否则 abort，log 'relabel: another process holds lock'
写盘：tmp 文件名带 pid；rename 前再确认 lock 属于自己
释放：结束（成功/失败）unlink；进程崩溃靠过期回收
```

## 3. apply 必须 all-or-nothing

**dry-run**：允许 unresolved，统计里单独列出。

**apply**（写盘）：只要出现下面任一情况 → **abort，marker 保留，原 index 一个字节不动**：

```
① readAllEvents 拿不全（见 §4）
② index 里任一 turn 无法重建 text（出现 unresolved）
   —— 必须在"写备份/写 tmp"之前检查；不能靠后面的字段校验兜底
      （旧行若已带同 stamp，字段校验会通过 → rename + 删 marker，留下未重标行）
③ 行数不一致
④ 非目标字段深度不等（**labelStamp 例外**，见下）
⑤ tmp 写入/rename 失败
```

**②的检查位置（创 2026-11-04 指出必须前置）**：第一遍打标收集分数后，
立即算 `unresolved = index 中 turn 不在 scored 里的行`；`> 0` → 直接 abort、**尚未写任何文件**。

**labelStamp 是第五个允许变更的字段（自相矛盾修正，创 2026-11-04 指出）**

§5.2 让每条记录带 `labelStamp`，而迁移只允许改 topic 四字段 —— 那第一次迁移就会被自己的校验 abort。

二选一的定案：**把 `labelStamp` 加进 `ALLOWED_FIELDS`**，并额外加一条强校验：

```
迁移把每行写成"本次依据的戳"（sha256(A表内容|阈值|labelerVersion)[:12]）
校验时：after[i].labelStamp 必须恰好等于本次 stamp
  · 不等（或缺失、或写成别的值）→ 视同越界，abort
```

这样"允许变"和"必须等于什么"同时成立，不会变成可以随便写 stamp 的口子。
（备选方案"迁移后再写 stamp"不采用：它会让迁移完成后的一瞬间存在"新 topic + 旧 stamp"的混合态。）

**明确不做"部分写"**：不写"能标多少标多少"。半套标签比旧标签更危险——它会让覆盖率看起来变好，实际是抽样偏差。

## 4. 事件读取：provider 入参 + 只认全量 API，不猜

**模块入参（in-process 与 CLI 的差别）**

```
runRelabelMigration({ indexFile, events, rawFile?, conceptsFile, markerFile, labeler, eventText, log })
  · events: async () => Event[]   插件内用（宿主没有 raw 文件路径，只有 sessionQuery.readSession）
  · rawFile: string               CLI 专用；与 events 二选一
  · 两者都没给 → abort 'no-event-source'
```

```
优先：sessionQuery.readSession(sessionId) → { events }
  （asset-tool / recall-tool / session-log-tool 都这么用，是最全的读法）
检查：读回来的 events 是否覆盖 index 中所有 turn
  覆盖 = index 里每个 turn 都能在 events 推出的 turn 集合里找到
  不覆盖 → abort（apply）/ 记 unresolved（dry-run）

若宿主只提供 readSessionTail(afterSeq, limit)（没有不带参的全量读）
  → **apply 直接 abort**，log 'full-read-unavailable'
  → 不写"反向翻页凑"的代码：只有当 API 明确支持 beforeSeq 时才谈翻页
```

理由：反向翻页在语义上要求"每页都稳定"，而 tail API 不保证；猜错一页就会出现"少了几轮但看起来成功"的迁移——这正是我们要避免的。

## 5. 要不要重扫：打分与增量（**新增，回应"每次重扫太占 CPU"**）

### 5.1 第一层：依据没变就不扫（毫秒）

判定依据只有三样：A 表内容、判定逻辑（labeler 版本 + 阈值）、打标输入规则。任何一样没变，重扫结果必然逐位相同（同模型、同输入、确定性）。

### 5.2 `labelStamp`：让"过期"可数

```
labelStamp = sha256(concepts.md 内容 + 阈值(topicMinScore/centerMin/lead) + labelerVersion)[:12]
```

`labelerVersion` 必须来自真实来源，但**不能用包版本**（创 2026-11-04 定）：

```
① bc-label.mjs 的显式常量 LABELER_VERSION（默认来源）
   · 只在"会改变打标结果"时手工 bump：分块规则、阈值默认值、center/lead 判据、
     描述相似度算法、文本拼接规则
   · 纯文档/日志/UI 改动**不 bump**
② marker.labelerVersion（仅回归测试时显式覆盖）
③ 都拿不到 → abort 'no-labeler-version'
```

用包版本会让每次发版（哪怕只改文档）把 stamp 全员失效 → 触发一次 30 分钟全量重扫，
与"增量/不扫"的目标直接冲突。

- updater 每写一行都带 `labelStamp`
- 迁移前统计：`stale = count(rows where labelStamp !== current)`

```
stale = 0        → 不扫（毫秒）
stale ≤ 5%       → 只重标 stale 行（增量）
stale > 5%       → 抽样估计，再决定
```

第一次迁移之后，新行自带当前 stamp，**A 表不变时永远是 0 行待标**。

### 5.3 抽样估计（stamp 变了才做）

```
随机抽 N=50 行（按 turn 均匀）
change_rate    = 改了的 / 50
coverage_after = 有 topic 的 / 50

决策：
  change_rate < 5%                     → 跳过（warn：表变了但影响小）
  5% ≤ change_rate < 20%               → 增量（只重标 stale 行）
  change_rate ≥ 20%                    → 全量
  coverage_after < 40% 且 rate ≥ 5%    → 无论多少都做
```

成本：抽样 50 行 ≈ 1 分钟；全量 2125 行 ≈ 30–40 分钟（今晚实测）。抽样是全量的 1/40。

### 5.4 打分公式（给面板/log 用）

```
staleness =
  0                         依据未变
  staleRatio (0–1)          有依据变更时的过期行占比
  sampledChangeRate          已抽样时用实测变化率（更可信）
触发：staleness > 0 且 (change_rate ≥ 5% 或 staleRatio ≥ 5%)
```

## 6. marker schema（v2）

```json
{
  "fields": ["topic"],
  "baseline": "self-loo",
  "conceptsHash": "<sha256>",
  "labelStamp": "<12 hex>",
  "thresholds": { "topicMinScore": 0.33, "centerMin": 0.02, "lead": 0.02 },
  "mode": "auto|full|incremental",
  "createdAt": "...",
  "attempts": 0,
  "lastError": null
}
```

校验：`fields` 必须恰为 `["topic"]`；阈值必须有限且在区间内（0.2–0.9 / 0–0.5 / 0–0.5），否则用默认 + warn；实际生效阈值写回 `effectiveThresholds`；`attempts > 3` 停止自动重试。

## 7. 失败与状态

- `conceptsHash` 不符 → abort，marker 保留
- 事件不全 / 有 unresolved / 行数或字段校验失败 → abort（原文件不动），`attempts += 1`
- 成功 → unlink marker，log 统计（重打、换 topic、→空、空→topic、覆盖率 before/after）
- 覆盖率 < 50% → **只 warn**
- 所有路径 try/catch 包住，不抛到 pre-step

## 8. 可观测性

`/dsh-continuity/state.json` 的 `engine` 增加：

```json
"relabel": { "pending": true, "sessionId": "...", "status": "running|done|abort|idle",
             "mode": "incremental", "stats": {...}, "startedAt": "..." }
```

## 9. 接线点（最小改动）

1. `bc-pre-step.mjs`：`getSession` 改 async；返回 `{skip:true}` 或 entry
2. pre-step handler：`await getSession(...)`，skip 就 `next()`
3. `bc-index-updater.mjs`：加 `whenIdle()`；`step` 内 save 前检查 gate
4. `index.mjs`：无需改动
5. `relabel-migrate.mjs`：入参改 `{ events: async () => Event[] }`；加 lock / all-or-nothing / stamp 过滤 / 抽样模式

### 9.1 实际实现（4.11.30，与上面两处不同）

`getSession` 保持**同步**，用哨兵返回，而不是改成 async：

```
const SKIP_DURING_RELABEL = Symbol('skip-during-relabel')
getSession(sessionId):
  entry 已缓存 → 直接返回
  否则：
    marker 存在 && 本进程没尝试过 → relabelAttempted.add + startRelabel()（后台，不 await）
    relabelling.has(sessionId) → return SKIP_DURING_RELABEL
    否则 → makeStep()（普通路径）
handler: entry === null || entry === SKIP → next()
```

**每进程只自动尝试一次（`relabelAttempted`）**：
abort 后不死循环重试（否则每轮都 abort 刷日志），本进程恢复普通索引，marker 留着等下次启动或人工处理。
"跳过"只与 `relabelling` 集合绑定，不与 marker 绑定——所以 abort 之后索引会正常继续。

**隔离性**：`installBCPreStep` 新增可选参数 `relabelRunner`（默认 `runRelabelMigration`），
测试可以注入假 runner，不需要模型、不碰真实 `~/.dsh`（用子进程 + 临时 USERPROFILE/HOME）。

## 10. 测试计划

单测：
- marker 缺失 / fields 非法 / baseline 非法 → no-op 或 abort
- conceptsHash 不符 → abort，文件字节不变
- 阈值非法 → 默认 + warn
- 锁 fresh → abort；锁过期 → 覆盖成功
- 事件不全 → **apply abort**（dry-run 记 unresolved）
- 行数/字段校验失败 → abort，原文件字节不变
- `labelStamp` 全等 → 0 行重标
- `decideTopic` vs labeler 判定一致（已验 8/8，固化成用例）

集成（临时 session）：
- 200 行小 index + 假事件源 → 成功：备份存在、marker 删除、非目标字段零改动
- 中途 kill → 重启：marker 在、tmp 被清理、再跑成功
- 迁移中触发 updater → 被 gate 挡住，不写盘

## 11. 上线顺序

1. 4.11.28：只合 `relabel-migrate.mjs` + 单测（不接线）
2. 4.11.29：加 `labelStamp` + updater `whenIdle()` + gate
3. 4.11.30：接线（后台 + skip + lock + state 暴露）
4. 观察 1–2 天，本 session 打 marker 试一次（覆盖率 27% 的 warn 会打出来）
5. 稳定后在 rules/模板写"其他鱼怎么用"：**先换 A 表 → 打 marker → 重启**

## 12. 已知取舍

- 迁移期间该 session 不索引（state 会补齐）
- 2k 行全量 30–40 分钟（本地 CPU，无网络）；增量与抽样把日常成本压到接近 0
- 覆盖率低于 50% 不自动修（阈值/baseline 应人工决定）
- workflow 不重标（等 workflow baseline ≥100 样本）

## 13. 实测结果（2026-11-05，真实 session）

第一次真实迁移（4.11.33）完成于 2026-11-05 10:29:35 → 10:33:06：

```
index 2148 行 · 重打 2148 · unresolved 0
换 topic 889（→空 158 · 空→topic 582）· 不变 1259
备份 bc-index.jsonl.bak-20261105023306
marker 删除；gate 释放；updater 追平（2150 行 / turn 2173）
labelStamp 覆盖 100%
```

分布：

```
有 topic      15.0% → 34.7%
活跃标签(≥1%)   2   → 9
最大单标签     权限与通知 12.2% → 跑团叙事 10.9%
```

**两个实测修正（比设计预估更重要）**

1. **速度：约 10 行/秒**（2148 行 / 211 秒）。
   ONNX 推理吃多核：实测 +47 CPU 秒 / 8 墙钟秒 ≈ 6 核。
   → **以后给别的实例估时用"2k 行 ≈ 3–5 分钟"**，不是 30 分钟。
   结论也跟着变：全量重标的代价比原设想低一个量级，"要不要采样/增量"的取舍可以放松，
   `labelStamp` 仍然保留（它省的是"没变也重扫"，不是"变了也要扫"）。

2. **`readSession` 是全量的**：83,463 事件 / 2,167 轮，8 秒读完。
   此前"有界快照"的猜测被实测否掉。
   **覆盖前置检查保留**——它不是为这个假设服务的，而是安全网：
   任何"事件不全"的情况都必须在打标之前 0.1 秒失败。

**踩过的坑（都已写进 rules）**

- 失败必须先留文件痕迹：console 在桌面进程里看不到（4.11.31 的日志代码还因 `fs` 未导入而全哑）
- `catch {}` 会吞掉"用了不存在的变量"：关键路径至少 `console.error` 一次
- 迁移必须用 **session 词表**（`sessionFile(sessionId,'concepts.md')`），不能用 persona/global 回退；
  否则 hash 永远不符、每次重启 0.1 秒 abort（实际症状：CPU/风扇抖一下就停）
- 测试夹具目录必须与生产同构，否则"路径正确"这类 bug 测不出来

### 13.1 安全增量（4.11.34）

`labelStamp` 全表已等于当前 stamp → 0 行重打、直接删 marker 完成；只要有一行 stale → 全量重标。

不做"逐行跳过 stale"：self-LOO baseline 会因少算行而偏，写出来的 centered 不可信。`forceFull` 可强制全量。

全量实测 3–5 分钟，所以增量首先是"没变就不扫"，不是省全量时间。
