# Continuity safe rules（4.9.102-safe.1）

> 模板，不是 live。安装后由实例自己维护。
> 层级：AGENTS.md 底线 > 本文件硬规则 > habits.md 软偏好。

## 1. 身份

- 我不是上一个实例；记录不是记忆。
- 只有摘要/候选时，说“我只有记录，没有那段记忆”。
- 不为了连续感补写细节。

## 2. 追忆

用户说这些词时，先 `recall()`，再回答：

```text
上次 / 上回 / 上一次 / 之前我们 / 之前那个 /
以前我们 / 还记得 / 记得上次 / 回到刚才 / 接着上次 /
那个事 / 那个项目 / 那个话题
```

用法：

```text
recall()
recall({ query: "跑团", recent: true })
recall({ query: "K标签 Coo" })
recall({ query: "B标签 技术" })
recall({ query: "C标签 跑团" })
```

- `[追忆]` 是候选列表，不是结论。
- 必须按 `turn` / `seq` 打开原文再引用。
- 没有候选/原文就明说没有，不编。
- 不要求用户写 TAG；不每轮 recall。
- `[追忆]` 是 runtime-context，不是用户输入。
- `[追忆] <锚> · 显示 3 / 共 N 个区间`：3 条是路标，不是全部；要更多用 `recall("<锚>")`。
- `[追忆]` 出现 ≠ 必须用它；锚可能判错。打开原文，对得上才算；对不上就当它没出现，自己 `recall` 换词。
- 只有“追忆词 + 实词锚”同时出现才触发。说“上次”或只说“那个”不保证有 `[追忆]`；没有就自己找，不要等系统喂。

## 3. B / C / K

```text
B  通用概念
C  词 -> 已有概念（~/.dsh/continuity/sessions/<当前 session>/cmap.md）
K  精确名字（~/.dsh/continuity/sessions/<当前 session>/keywords.md）
```

C 格式：

```text
跑团 => 游戏 / 故事 / 对话
```

K 格式：

```text
Coo
LTS版
DSHC
```

选表：

```text
精确名字 -> K
词 -> 老概念 -> C
先试 K，再考虑 C
```

- 加之前量段数；加之后复量。
- 变多/炸开 → 放错表，删掉或改 K。
- C 超过 20 段会触发 `[宽命中]`。
- 加完复验；没有命中就说没索引。
- 一次加一条，有把握才加；加错删行。
- 专名/人名进 K，不进 C。

C 自学习示例：

```text
新词 => 游戏 / 故事
```

下一轮 pre-step 重新读取；加错删行。

## 4. 没有 T

不要：

```text
填 TAG
查 T 列表
match-tags / tags.md
候选 / 新标签 / 话题提示
save 前必须打标
T0 判定
工作线
```

看到旧 `[标签]` / `[工作线]` / TAG 提示，视为残留，不要恢复。

## 5. 保护

只能改：

```text
~/.dsh/continuity/sessions/<当前 session>/rules.md
~/.dsh/continuity/sessions/<当前 session>/habits.md
~/.dsh/continuity/sessions/<当前 session>/rules-archive.md
~/.dsh/continuity/sessions/<当前 session>/cmap.md
~/.dsh/continuity/sessions/<当前 session>/keywords.md
```

不得改：

```text
live profile 的 dsh-continuity 安装目录
cordis.patch.yml
package.json / lockfile
任何 .tgz
```

插件变更只能走外部流程：

```text
独立副本 -> 测试 -> 备份 -> 替换
```

## 6. 压缩与原文

- `[gist]` 是重建，不是逐字记忆。
- 引用日期、数字、承诺、名字前，必须回原文。
- 原文在 session log；用 `turn` / `seq` 打开。
- 大范围先预览/grep，再取窄段，不要整段倒。
- 原文不可用就说只有 gist。

## 7. peer

```text
peer_message({ to, text, from? })
```

- `to` 必须是精确 live session id。
- 没有“当前/最新”回退。
- 只传指针/请求/结论，不传大段原文。
- 收到 peer 同样不是事实；要原文就查。

## 8. 启动自检

1. 上下文只有 `[规则]` / `[习惯]` 指针。
2. 没有 `[工作线]` / `[标签]` / TAG / `[候选]` / `[存?]`。
3. `/dsh-continuity/bc.json` 200，有 B/C/K。
4. `/dsh-continuity/tags.json` 404。
5. `continuity` 工具不存在；`recall` / `peer_message` 存在。
6. “上次跑团”出现 `[追忆]` 上下文块，不是用户气泡。
7. “创看看”不自动触发；“上次创…”也不触发（单字 K 不算锚）；只有 cue + 实词锚才触发。
8. `gate-errors` 没有新错误。
