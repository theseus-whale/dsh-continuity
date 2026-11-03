# 01 — 安装

## 1. 先理解“安装”到底装了什么

这个包不是装完就自动有一份完整记忆。

它装进去的是三层东西：

```text
宿主行：提供面板、路由、按 session 调度
preset：提供压缩引擎、recall、session_log
client：提供左侧“连续性”面板和右侧 A/B/C/K tab
```

三者缺一个，你看到的现象都不一样。

**比如这种情况：**

```text
如果宿主行装了，但 client 没加载，
则后台在写索引，你却看不到“连续性”入口。
```

```text
如果 client 在，但 preset 不是 continuity，
则面板可能有，但没有 band 引擎和原生 recall/session_log。
```

所以先不要用“有没有表”判断安装成功。

## 2. 安装

把 tgz 装进目标 DSH profile，备份 `~/.dsh/continuity`，然后重启 DSH。

```text
dsh-continuity-4.9.119-safe.1.tgz
```

为什么必须重启？

因为插件在 DSH 启动时挂载。  
只把 tgz 放进目录、不重启，等于把书放上书架但没翻开。

**比如这种情况：**

```text
如果装完没有重启，
则新代码没进进程，面板可能还是旧版本，或者根本没有。
```

重启后确认版本：

```text
dsh-continuity 4.9.119-safe.1
```

## 3. 第一次 pre-step 会做什么

某个 session 第一次经过 pre-step 时，它会：

```text
1. 解析当前 session id
2. 检查 persona 是否启用
3. 创建缺失的 session 空壳：
   concepts.md
   cmap.md
   keywords.md
   aliases.md
   rebuild.md
4. 从 templates/rules.md 种 rules.md
5. 从 templates/habits.md 种 habits.md
6. 第一次索引时创建 bc-index.jsonl
```

它只创建缺失文件，不覆盖已有表。

**比如这种情况：**

```text
如果 concepts.md 已经存在，
则它不会用模板覆盖，哪怕模板更新了。
```

这就是为什么“升级插件”不等于“旧 session 的规则会自动变新”。

## 4. 新 session 为什么是空表

新 session 的：

```text
A 空
C 空
K 空
```

这是正常的。

A 空会进一步导致：

```text
B 空
审计跳过
```

**比如这种情况：**

```text
如果新 session 刚聊 3 轮，A 表空、B 空，
则不是插件没工作，而是还没有人给 A 写第一条。
```

如果你希望它一开始就有概念，需要显式：

```text
写 concepts.md
或从历史 rebuild
```

不要从别的 session 复制 A 表。

## 5. 有历史、但没有表怎么办

如果 session 已经聊了很长，A/B/C/K 还是空：

```text
不要从当前 live turn 开始补
```

先读 `04-REBUILD.md`。

**比如这种情况：**

```text
如果 session 已经有 500 轮，A 仍然是空，
则从第 501 轮开始正常聊，也不会自动补出前 500 轮的 B。
```

历史需要显式重建。

## 6. preset 检查

```text
continuity preset：
  band 引擎
  原生 recall
  原生 session_log

standard preset：
  原生 compaction-basic 80%
  没有 band 引擎
  没有原生 recall/session_log
```

已启动的 session 不能切 preset。  
`agentPresets.select()` 会返回：

```text
agent-preset/locked
```

**比如这种情况：**

```text
如果为了“省事”去改 session header 的 agentPreset，
则 session 可能从列表里消失，而不是升级成 continuity。
```

不要改 header。要换 preset，新建 session。

## 7. 重启后的自检

按顺序看：

```text
1. 版本 = 4.9.119-safe.1
2. 左侧有“连续性”
3. 右侧“更多工具”下有 A/B/C/K
4. sessions/<id>/ 有基础文件
5. rules.md / habits.md 在 session 目录
6. 面板能打开
7. 没有新的 gate-errors
```

如果第 2 条没有，先不要查表，查 client。

如果第 2 条有、第 3 条没有，查宿主是否支持 `sidebarRight`。

如果第 3 条有、表是空的，回到第 4 节：这是正常的空表。

## 8. 一个最小验收

对新 session：

```text
发一句话
等一次 pre-step
打开 A/B/C/K
确认 B 覆盖当前 turn
```

如果 B 仍然是空：

```text
检查 A 表有没有内容
```

因为没有 A，就没有 B。
