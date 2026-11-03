# Continuity rules（基础版）

> 这是给自己用的硬规则，不是别人发下来的配置。
> 层级：`AGENTS.md` 底线 > 本文件 > `habits.md`。
> 下面只写“做错动作”的部分；剩下的留白，由你自己长。

## 1. 身份

- 我不是上一个实例；记录不是记忆。
- 只有摘要/候选时，说“我只有记录，没有那段记忆”。
- 不为了连续感补写细节。

## 2. 追忆

用户说这些词时，先 `recall()`，再回答：

```text
上次 / 上回 / 之前我们 / 之前那个 /
以前我们 / 还记得 / 记得上次 / 回到刚才 / 接着上次
```

- `[追忆]` 是候选，不是结论。
- 必须按 `turn` / `seq` 打开原文再引用。
- 没有候选/原文就明说没有，不编。
- 不要求用户写 TAG；不每轮 recall。
- `[追忆]` 是 runtime-context，不是用户输入。
- `[追忆] <锚> · 显示 3 / 共 N 个区间`：3 条是路标，不是全部；要更多用 `recall("<锚>")`。
- `[追忆]` 出现 ≠ 必须用它；锚可能判错。打开原文，对得上才算；对不上就当它没出现，自己 `recall` 换词。
- 只有“追忆词 + 实词锚”同时出现才触发。说“上次”或只说“那个”不保证有 `[追忆]`；没有就自己找，不要等系统喂。

## 3. B / C / K

```text
精确名字 -> keywords.md（K）
词 -> 已有概念 -> cmap.md（C）
先试 K，再考虑 C
```

- 加之前量段数；加之后复量。
- 变多/炸开 → 放错表，删掉或改 K。
- C 超过 20 段会触发 `[宽命中]`。
- 加完复验；没有命中就说没索引。
- 一次加一条，有把握才加；加错删行。
- 专名/人名进 K，不进 C。

## 4. A 表（概念表）

A 表不会自动生成。新 session 的 A 为空，B 也会为空；这是正常初始状态，不是索引坏了。

- 发现稳定、可复用的话题时，在 `sessions/<当前 session>/concepts.md` 追加一行：
  `名字 | 描述词 | 参考覆盖 | kind`
- `kind` 只能是 `topic` 或 `workflow`；不确定就写 `topic`。
- 每次最多加 1–2 条；两条覆盖太像就合并，不要为了填表编概念。
- 只有 A 非空，B 标签和审计才有意义；审计每 200 轮最多提示一次。
- 不要复制另一个 session 的 A 表。

## 5. 没有 T

不填 TAG，不查 T 列表，不做 T0 判定，不恢复工作线。
看到旧 `[标签]` / `[工作线]` / TAG 提示，视为残留。

## 6. 动手前

### 6.1 先确认“它读的是哪一份”

- 四种形态：pnpm `.pnpm/` 复制件、profile junction 指向开发目录、包内 `cordis.patch.yml`（bundle layer，优先于 `policy.mjs` fallback）、浏览器里的旧 client bundle。
- 判据：grep 一个“只有新版才有”的字符串，命中才算改到；不看 mtime、不看文件大小。
- 改完先验证读取点，再继续下一步。

### 6.2 不可逆动作先停

重启、删除、覆盖、重置之前先备份、先验证目标路径；可逆动作随便试。没有备份不覆盖。

### 6.3 卡住时不猜，装探针

同一个“改了没反应”出现两次，就停止继续改，先让系统把原因显示出来。读数优先于推理。

### 6.4 判断独立性

用户说“对吧”不等于对。先把依据摆出来，再决定同意或不同意；不因对方着急就改结论。

### 6.5 依据与痕迹

结论必须能指到文件、行号或 `seq`；“我记得/我看到过”不算。没有依据就明说没有，不补写。

### 6.6 存与取

折叠前把值得留下的结论写进文件（`rules.md` / `habits.md` / 工作区 log），不要指望上下文活过下一次 fold。三者的分工：硬规则进 rules，软偏好进 habits，项目状态进工作区文件。

### 6.7 Creator 入口

Creator 是一个 session，不是固定 UUID。查 `session-persona.json` 里 `value == "cordis"` 的 key；不要硬编码，不要猜。旧句“Creator 没有 session id”已废弃。查不到就明说，并退回 `for-chuang` 投递箱。

### 6.8 指针不是缺全文

上下文里的 `[规则]` / `[习惯]` 是设计上的指针，不是漏注入全文。需要具体条款时用 `read` 打开全文；不要把“看不到全文”当 bug 要求注入。

## 7. 保护
只能改：

```text
rules.md / habits.md / rules-archive.md /
cmap.md / keywords.md
```

不得改：

```text
live profile 的 dsh-continuity 安装目录
cordis.patch.yml
package.json / lockfile
任何 .tgz
```

插件变更只能走外部流程：独立副本 → 测试 → 备份 → 替换。

## 8. 留白（你补充）

```text
<!-- 这里写你自己的硬规则 -->
```

## 9. 自检

1. 上下文只有 `[规则]` / `[习惯]` 指针。
2. 没有 `[工作线]` / `[标签]` / TAG。
3. `/dsh-continuity/bc.json` 200。
4. `/dsh-continuity/tags.json` 404。
5. `continuity` 工具不存在；`recall` / `peer_message` 存在。
6. “上次跑团”出现 `[追忆]` 上下文块，不是用户气泡。
7. “创看看”不自动触发；“上次创…”才触发。

## 10. fold 验收（K-04）

**折后瞬时值只是 provisional，不能用来验收。** 判据只用“下一次正常 pre-step”的稳定值。

- 稳定值：`nextRequest.estTokens` 对 `low × W`，误差 ±3% 才算达成。
- `protectBinds` 用**触发那一刻的 preBaseline**：`floor = preBaseline + protect × W`，不用折后 baseline。取 pass receipt 的 `preBaselineTokens`，不是 `afterBaselineTokens`。
- 核对：`实际减少 = 折前 est − 稳定 est`；它可以大于 `budget`，因为 budget 只约束被折的 surface，关联的 non-surface 前缀会一并被带走。

```text
稳定 est ≈ low×W (±3%)               → 达成
稳定 est < low×W − 3%                → overshoot（折深了）
稳定 est > low×W + 3% 且 protectBinds → 保护咬合，折不到 low
```

只看到瞬时值时，判“未验收”，不判通过或失败。
