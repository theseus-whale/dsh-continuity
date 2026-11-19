# @theseus-whale/dsh-continuity 5.0.3

DSH Host 内的连续性插件。公开默认均为 **off**；只有本地 overlay 中明确列出的会话才会启用记忆共振、轮末归档和统一折叠。

## 当前能力

```text
memory resonance    Host-turn summaries/vectors for allowlisted sessions
memory_recall       LLM 主动调用同一语义共振路径
memory_rebuild      Host 后台全量重建、补增量、验证并原子激活
turn-end archival   stable queue + background worker + atomic deltas
raw write index     canonical events 的即时词法指针，无需模型
unified fold        精确证据复用，缺失覆盖在折叠时补齐
exact readback      bounded seq reads and verified raw-chunk reads
panel               waterlines, model window, runtime and tool catalog
```

## Host-only 模型调用

所有摘要请求都在 DSH Host 内通过 `ctx.llm` 发出，并使用宿主配置的 provider/model。`memory_rebuild` 的调用方只提交或控制任务，不逐条编写摘要，不创建子代理或额外会话。

本包**不包含 Node CLI、独立 DeepSeek transport、external provider module 或 API Key 输入路径**。全量重建使用 shadow staging，补到最新 checkpoint 后才切换 live；失败或取消保留旧索引。

## Public defaults

```yaml
turnPing:
  enabled: false
  mode: shadow
  localConfig: ./local/memory-resonance.json

unifiedFold:
  enabled: false
  localConfig: ./local/unified-fold.json
```

本地 overlay 缺失即禁用，格式错误会报告错误；启用时必须提供明确的 `sessionIds`，不会自动扩展到全部会话。

## Quiet automatic recall

自动共振默认使用 `quiet`：只有回溯意图明确的输入才检索；当前可见或近期推过的记忆会被去重；候选按向量新颖度动态筛选，不固定为一条。`autoRecall.mode` 支持 `quiet / off / legacy`，主动 `memory_recall` 不受影响。决策写入会话本地 `cue-decisions.jsonl`。

## Requirements and verified Host

```text
Node.js >=22
DSH host supplies the peer packages
```

Verified against the installed DSH desktop runtime `0.2.2-rc.3`, Cordis `4.1.0`, and Host peer packages `0.2.2-rc.3`. This is a tested baseline, not a claim of support for every future Host.

## Install

```text
npm install <path-to-theseus-whale-dsh-continuity-5.0.3.tgz>
```

安装、备份、overlay、重建与回滚步骤见 [INSTALL.md](INSTALL.md)。

## Vector-L 摘要约定

生成提示要求一行、一个中文句子、目标约 100 字、256 字以内，可用分号；历史原文只作为待摘要资料，不作为当前对话回答。生产收录仍是软约束：超长、多行、多句会保留并记录警告，不重试、不拒绝；共振展示不截断。

## Data and cost boundary

```text
raw write index           local derived full-text/pointer cache; no model call
local BGE embedding       local model; no text leaves the machine for embedding
turn-end summary worker   explicit opt-in; Host ctx.llm generates summaries
unified fold              reuses exact coverage; generates missing/stale turns
memory_rebuild            explicit tool action; Host writes shadow before activation
panel                     read-only; never calls provider
```

公开包不含凭据、真实会话 ID、用户 home 路径、私有 overlay、测试或模型权重。模型准备见 [docs/MODEL.md](docs/MODEL.md)，本地配置见 [docs/PORTABILITY.md](docs/PORTABILITY.md)。
