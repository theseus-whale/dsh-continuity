# History map 的既定行为

> 2026-11-06。适用于 `dsh-continuity` 的 active history-map。
>
> 这不是“可调度摘要”：它必须自动进 surface。否则它跟一份文件没有区别。

## 1. 位置

```text
system/message
[continuity:history-map]     ← system 之后第一条
...
retained original tail
```

`ensureHistoryMap` 用：

```text
surfaceOp: { op:'replace', startSeq, endSeq }
sourceEventSeqs: [...]       // 顶层字段，不在 surfaceOp 里
```

把最前面的一段替换成 map。

不是 append 到尾部。  
append 只能加在末尾，不能构成“摘要 + 原文”的顺序。

## 2. 刷新条件

```text
hash 不变 + carrier 在 surface  -> 不动
hash 变（新 fold / excerpt 规则变）-> replace front 单节点刷新
carrier 不在 surface（被折叠/清除）-> 重新注入
```

`history-map-probe.json` 每次 `ensureHistoryMap` 写一次，字段：

```text
at / sessionId / nodeCount / frontSeq / frontIsCarrier
mapPath / mapPathExists / indexRecords / builtChars
range / reason / error / carrierSeq
startSeq / endSeq / seqCount / seqFirst / seqLast
```

常见 `reason`：

```text
returned-front-carrier     front 已是 map，hash 未变
updated-front-carrier      front 已是 map，hash 变了并刷新
returned-no-index          summaries/index.json 不存在
returned-no-range          找不到可替换区间（兜底应只换 front）
returned-dedup             进程内 bootstrap 记录命中（仅同进程热路径，非持久状态）
ok                         首次 front replace 成功
error                      读 index / build / replace 抛错
```

`returned-dedup` 不能当作“已注入”的持久证据：进程重启后 Map 清空，它会重新走 front replace。

### 模式

```text
~/.dsh/continuity/history-map-mode
  off       完全不动作（默认）
  observe   只写 probe，不注入 / 不 replace / 不 stub
  auto      注入 + 自刷新（实验档）
```

默认 `off`：native checkpoint 是唯一小抄，fold 必写，位置由 native 保证。  
history-map 不再作为默认中间层；`auto` 只保留为实验档。

`auto` 下 front 已是 `compact-checkpoint` 时 no-op，不再用 map 替换 native summary。  
`observe` 下 `oldestRange` 不跳过 map，便于观察 native fold 是否把旧 map 折入。

## 3. 显隐

```text
surface 上：1 条 active map + 若干 map-stub
raw 里：历史 map / stub 事件都保留
```

`map-stub` 用独立 marker：

```text
[continuity:map-stub] (superseded)
```

原因：stub 也以 `[continuity:history-map]` 开头的话，会被 `findHistoryMapCarriers` 当成 carrier，
导致每轮都误判 extras、重复注入。

stub 的 replace 也必须带顶层：

```text
sourceEventSeqs: [seq]
```

## 4. cap 取舍

顺序：

```text
位置
-> 最新区间（新 -> 旧）
-> 上次索引之后的 fold
-> 长期结构
-> 取原文
```

规则：

```text
单个区间 excerpt 上限：6,000 字（总 cap 内的分配，不是每段都保证 6,000）
同一区间多条 record：toSeq 降序，再按正文长度降序；最多取 2 条并均分 excerpt
超 cap：先丢最老区间，保最新区间
长期结构最后才丢
```

当前 0b 实测：

```text
总长 12,587 字 ≈ 3,147 tokens（cap 4k）
最近区间 83294-84075 6,012 字
80911-81009 被 cap 丢掉（预期）
```

## 5. 信息边界

```text
map 是索引，不是原文。
细节以 raw / session_log 为准。
```

`front replace` 会真的从 **surface** 移除旧文本。  
raw 仍在 session log；这不是删除原文。

既定代价：

```text
surface 上的摘要可能比 raw 短；
map 替换 native checkpoint 后，surface 不再有那份 checkpoint 原文；
需要原文时按 seq 回 session_log 取。
```

不要因为“surface 摘要比 raw 短”把它当成新 bug。

## 6. bootstrap replace 与 archive

成功 front replace 后，engine 写：

```text
sessions/<id>/summaries/bootstrap-ranges.json
```

summary-index 构建时读取这个侧车，把 bootstrap replace 的区间并入 coverage，
避免重建 index 时把这段误判成 pending window。

可核对的分叉信号：

```text
pendingWindows 变大 = 分叉开始
现在 pending 仍 0，所以尚未分叉
```

两个语义边界：

```text
1 boot 段是 covered-without-summary
   并入 coverage 后 pendingWindows 会被结构性压到 0，
   即使那段没有可读摘要文本。
   pending 0 不等于“都有摘要”，只等于“有 surface 替代”。

2 boot 段没有 release 语义
   如果 front map 被折叠/删除，sidecar 记录仍在，coverage 仍宣称覆盖。
   记录带 carrierSeq，但当前扫描不校验 carrier 是否还存在。
   以后要加：carrier 不在 surface 时把该段标 stale，不并入 coverage。
```

侧车形状：

```text
{ version:1, ranges:[{ fromSeq, toSeq, tokens, carrierSeq, at }] }
```

## 7. pending window 生成器

当 `pendingWindows > 0`，可以显式生成抽取式 window summary：

```bash
node bin/summary-index.mjs --raw <session.v4.jsonl.zstd> --session-dir <dir> \
  --extract-pending --apply
```

行为：

```text
1 先建 base index，列出 pending
2 对每个 pending 生成 300-800 tokens 的抽取式摘要
3 写 summaries/windows/<from>-<to>.json
4 用 windowRanges + windowRecords 重建 index
   pending 归零；window 以 kind:'window-extractive'、quality:'extractive' 进入 records
```

抽取式内容是 fallback，不是 LLM 摘要；结构保留用户/助手/工具和 raw seq 指针。

过滤掉的注入前缀：

```text
[continuity:* / 追忆 / 抽取 / 工作线 / 标签 / 规则 / 规矩 / 习惯 / 技能 / 归位 / 候选 / 存? / 闸 / 回正 / 学习 / 记忆 / 创 / peer]
<system-reminder>
Current runtime context
Time sampled while preparing
```

2026-11-06 live 0b 第一次 apply 混入 `[规则]`（实际是 peer `[创]` 正文引用），已回滚；
最终版本把 peer 保留为独立角色：

```text
window-84076-88063
kind window-extractive / quality extractive
2,205 字 / 552 tokens
## 用户   只留真实用户
## 同伴   [创] 内容，标 (peer) seq ...
## 助手   只抽有正文的 assistant/message
standalone [规则] line = false
records 159 / pending 0 / windows 1
map preview 87FDA63E / 11,772 字 / 2,943 tokens
backup: backups/summary-index-window-20261106/index.json.before-assistant-sampling
```

peer 内容不再过滤，也不会被归进「用户」。  
assistant 采样只收 `textOf(event)` 非空的节点，避免 479 条里只抽到空段。

## 8. 已知未完成

```text
1 window 生成器目前是抽取式 fallback，不是 LLM 摘要
2 band / protect 未改；protect 仍是 0.20
```

snapshot/summary 事件已按 `session.seq` 增量缓存；首轮全量，后续只读新增 seq。

## 9. 修改前检查

```text
1 sourceEventSeqs 必须在 append options 顶层
2 replace 端点用 surface 顺序，不要 min/max 归一化
3 stub 必须带顶层 sourceEventSeqs
4 cap 顺序不能反过来
5 改完先看 history-map-probe.json 的 reason
```
