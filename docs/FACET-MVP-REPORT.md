# Facet MVP 报告

## 已完成

```text
src/facets/schema.mjs     固定 6 槽 facet 词表 + alias 表
src/facets/extract.mjs    规则/词典回退提取器
src/facets/index.mjs      每 turn facet 索引、idf、alias 查询、seq 排序
src/facets/scanner.mjs    增量 seq 扫描器 + residual 队列
bin/facet-mvp.mjs         CLI
test/facets.test.mjs      4 个测试
```

## 模块

```text
buildFacetIndex(rows)       rows -> entries + idf
queryFacets(index, alias)   alias -> facet 集合 -> 排序 -> ranges
indexStats(index)           分布/unknown 统计
scanRows(rows, cursor)      从 cursor.lastSeq 往后扫，unknown 进 residual，不阻塞
```

## 第 100 轮真实快照测试

数据：Continuity 1381–1480 的 100 个 turn；facet 由模型只读正文产生（不是规则提取器）。

```text
查询 跑团  → 54 matches
查询 调试  → 19 matches
查询 测试  → 20 matches
unknown    → 0
```

跑团命中的 seq 段示例：

```text
56006–56051 (turn 1381–1386)
56069–56141 (1389–1396)
56159–56186 (1399–1401)
56224–56305 (1408–1413)
```

## 测试

```text
node test/facets.test.mjs   4 pass
npm test                    全部通过
npm run check               通过
```

## 规则提取器 vs 模型 facet（同一批 100 turn）

规则/词典提取器（`extract.mjs`）：

```text
unknown         41 / 100
activity 跑团    4 / 54
查询“跑团” matches 0
```

模型 facet（只读正文，作为索引输入）：

```text
unknown         0 / 100
activity 跑团    54 / 54
查询“跑团” matches 54
```

结论：**索引/查询层已经可用；提取层是瓶颈。**  
规则词典只能做 v0 fallback，真正可用必须接小模型/embedding 分类器。

## ONNX/embedding 小模型

`src/facets/embedding.mjs`：

```text
@huggingface/transformers
Xenova/bge-small-zh-v1.5
ONNX/WASM，本地缓存
hf-mirror 只用于首次下载
```

分层 holdout，train 52 / test 48：

### embedding only

```text
activity      91.4%  coverage 72.9%
interaction   93.9%  coverage 68.8%
participants  70.2%  coverage 97.9%
medium        87.0%  coverage 95.8%
topic         94.3%  coverage 72.9%
```

### embedding + NB fallback

```text
activity      83.3%  coverage 100%
interaction   83.3%  coverage 100%
participants  68.8%  coverage 100%
medium        87.5%  coverage 100%
topic         85.4%  coverage 100%
```

### slot-aware fusion（embedding 只赢 4 个槽，participants 留给 NB）

```text
activity      83.3%  coverage 100%
interaction   83.3%  coverage 100%
participants  83.3%  coverage 100%
medium        87.5%  coverage 100%
topic         85.4%  coverage 100%
```

结论：embedding 在“敢答”时更准，但 coverage 低；按槽融合后 coverage 100%，participants 回到 83.3%。  
0.9.2 使用 slot-aware fusion。

### embedding worker

```text
src/facets/embedding-worker.mjs
src/facets/embedding-service.mjs
```

worker 同时加载：

```text
prototypes JSON
可选 NB model JSON
```

返回 fused facets；模型推理不在主线程。

验证文件：

```text
last100/FACET-EMBEDDING-VALIDATION.json
```

## 敏感度曲线与折叠优先级

`src/facets/sensitivity.mjs`：

```text
IDF 加权 cosine
coverage² 惩罚
减去全语料 baseline
3 窗 EMA（0.5/0.3/0.2）
```

last100 查询“跑团”：

```text
跑团段平均 smoothed：0.275
技术段平均 smoothed：0.0048
≈ 57 倍分离
最高：0.316（1381）
最低：0（技术段）
```

CLI：

```powershell
node bin/facet-curve.mjs --input rows.jsonl --query 跑团 --out series.json
```

同一模块的 `foldPriority()` 用 `(1-score)×age` 排序，先折低相关老段，保护高相关当前话题。

验证文件：

```text
last100/FACET-CURVE.json
```

## 面板快照与 load 提示

`src/facets/panel.mjs`：

```text
buildFacetPanel()
  totalTurns / unknown / facetSum
  每槽计数
  当前 alias → facet pairs（含挂载 turn 数）
  sensitivity curve

buildLoadHint()
  只在该话题最近窗口没有出现时返回一行 [回忆?]
```

last100 面板：

```text
总 turn：100
facet 计数和：600（6 槽 × 100）
unknown：0
当前话题：跑团
pairs：activity 跑团 54 / interaction 回合制 54 / random 有 0 /
       participants 协作 89 / medium 文字 84 / topic 剧情 47
```

`random 有 0` 是故意暴露的异常项：alias 声明了“随机”，但 last100 里没有机制词，
用户可以据此指出 alias 不合理；面板不替用户掩盖。

输出：

```text
last100/FACET-PANEL.json
```

### 面板接线（0.9.x 预演）

```text
host:   /dsh-continuity/facets.json
file:   ~/.dsh/continuity/facet-panel.json
client: 有 facet 快照时显示 facet 视图；没有时回退 T 列表
```

生成快照（显式 opt-in，不自动写 live）：

```powershell
node bin/facet-panel.mjs --input rows.jsonl --out $HOME\.dsh\continuity\facet-panel.json --alias 跑团
```

面板显示：

```text
当前话题 + alias-facet pairs
facet 总计数 / unknown
敏感度曲线
显示 T 列表（回退）
```

### facet load 查询

```powershell
node bin/facet-load.mjs --index facet-index.json --query 跑团 --top 5
```

输出：

```text
alias → facet 集合
ranges
seqs（可直接给 continuity.load 的 seqs）
```

这是“引导模型 load”的第一步：模型不再需要知道 T，只需要 query。

### continuity.load({query})

`load` 新增可选 `query`：

```text
continuity.load({ action: "load", query: "跑团" })
→ facet-index.json → seqs → 正常 load
```

不要求模型知道 T；返回里带 `facetQuery` 的 ranges/seqs 数。  
没有 index/没有命中时返回 `facet-no-match`，不会静默切 T。

## high 触发折叠计划

`src/facets/fold-plan.mjs`：

```text
planFacetFold(entries, {query, idf, budgetTokens, recentTurns})
```

行为：

```text
最近窗口 → protected
高 relevance 当前话题 → protected
老的低 relevance → 按 (1-score)×age 排序
按 token budget 取低相关 seq ranges
```

这是 high trigger 的候选计划；引擎已能在 `config.facetFold` 存在时，
于 `band-high` / `emergency` 分支优先使用它，并检查：

```text
active tool pin
tool pairing before/after
```

不满足时回退原来的 oldestRange。引擎默认读取：

```text
~/.dsh/continuity/facet-fold.json
```

存在时自动用于 `band-high` / `emergency`；不存在时行为不变。生成：

```powershell
node bin/facet-fold.mjs --input rows.jsonl --out $HOME\.dsh\continuity\facet-fold.json --query 跑团
```

## facetNative（T 降为 alias 的过渡开关）

引擎配置：

```text
facetNative: true
```

行为：

```text
跳过 turn-stopping 的 TAG 补标催办
facet/load/query 仍可用
T 仍作为 save/load 的 alias 存在，但不再强制每轮打标
```

默认 `false`；显式开启才改变回合闸。

## random facet 修复

`src/facets/random.mjs` 只认显式机制词：

```text
掷骰 / 骰子 / 骰 / D20 / 检定 / 抽卡
```

全历史 1474 turn 验证（正例标签由同一组机制词生成，因此这是规则校准，不是人工 gold）：

```text
positive：73
recall：1.00
falsePositive：0
precision：1.00
```

说明：last100 里这组机制词命中为 0，所以那 100 轮的 `random=无` 现在 **不是退化，而是输入里确实没有机制信号**。  
全历史里有 73 轮会被标成 `random=有`。

## 本地 worker

```text
src/facets/worker.mjs   加载 model JSON，消息循环
src/facets/service.mjs  主线程 client，超时/关闭
```

测试：

```text
facet worker extracts off-thread from a serialized model  ✔ 45ms
```

宿主主线程不再直接跑分类推理。

worker 端到端跑 last100（模型在全部 100 上训练，仅验证链路，不是泛化指标）：

```text
index entries：100
unknown：0
查询“跑团”：52 matches
真实跑团：54
true positive：52
precision：1.00
recall：0.963
```

## 闭环验证

`bin/facet-validate.mjs`：分层 holdout → 训练本地 NB → hybrid extract → 建索引 → alias 查询。

最近 100 turn，train 52 / test 48：

```text
activity      81.3%
interaction   81.3%
participants  83.3%
medium        85.4%
topic         83.3%
```

查询“跑团”：

```text
test 中真实跑团 turn：27
命中：26
precision：1.00
recall：0.963
```

唯一漏掉的是 27 个中的 1 个。  
输出在：

```text
coopanion-continuity/backups/continuity-tags-20261031/last100/FACET-VALIDATION.json
```

结论：**raw text → 本地提取 → 索引 → alias 查询 → seq 范围，这条闭环成立。**

## CLI 增量扫描验证

```text
node bin/facet-scan.mjs --input rows-a.jsonl --dir facet-state --query 跑团
node bin/facet-scan.mjs --input rows-b.jsonl --dir facet-state --query 跑团
```

结果：

```text
第一次 scanned: 50
第二次 scanned: 50
facet-index entries: 100
facet-cursor.lastSeq: 56460
residual: 0
查询“跑团”: 54 matches（topK 以内）
```

## 本地 Naive Bayes 学生模型

`src/facets/classifier.mjs`：字符 bigram + 多项式朴素贝叶斯，无外部依赖。

### 按时间切分（前 50 训练 / 后 50 测试）

```text
activity      accuracy  8%   coverage 100%
interaction   accuracy  8%   coverage 100%
random        accuracy 100%  coverage 100%（全预测“无”）
participants  accuracy 78%   coverage 100%
medium        accuracy 68%   coverage 100%
topic         accuracy 44%   coverage 100%
```

这是**分布偏移**：前 50 轮几乎全是跑团，后 50 轮几乎全是技术工作。8% 不代表模型本身。

### 分层切分（每个 activity 交替进 train/test）

```text
train 52 / test 48
activity       81.3%
interaction    81.3%
random        100.0%（仍全是“无”）
participants   83.3%
medium         85.4%
topic          83.3%
```

结论：**同样的 Naive Bayes，在代表性训练集上可以到 81%**；  
真正的问题不是模型类型，而是**类别分布**和 `random` 特征退化。

### 可持久化模型

```text
node bin/facet-train.mjs --input rows.jsonl --out facet-model.json
node bin/facet-scan.mjs --input rows.jsonl --model facet-model.json --dir .facet --query 跑团
```

模型是普通 JSON；换 ONNX 时只替换 `classifierExtractor`，索引/查询不变。

## 已知限制

1. `extract.mjs` 只是词典回退，不是小模型；对“掷骰”等能命中，对隐含语义不行。
2. 模型 facet 输出有质量问题：最近 100 轮 `random` 全是“无”，漏了掷骰。
3. 没有接大模型 residual 命名，也没有接 ONNX 小模型。
4. 没有写进 Continuity 的 load 工具；目前是独立模块/CLI。
5. 查询没有做“所有 facet 必须同时命中”的严格 AND；当前按覆盖度 >= 0.6。

## 下一步

```text
1. 用规则提取器跑 last100，比较它与模型 facet 的差异
2. 把 facet-index 接入 continuity load 的 query 分支
3. residual 聚类 + 大模型命名（离线命令）
4. ONNX 小模型 worker
```

## 数据安全

没有修改 `~/.dsh/continuity` 的任何文件；测试只读 last100 快照。
