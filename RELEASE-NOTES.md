# 发行说明 — 4.9.120-safe.1

## 平衡带 0.48/0.32（4.9.120）

```text
high 0.48 · low 0.32 · setpoint 0.48
emergency 0.65 · emergencyTo 0.42
protect 0.30 · maxPerBatch 190k · minAction 24k
```

0b 窗口：high 380k，low 254k，均值约 317k，折叠约 7.9 次/1M；4.9.117 是 321k / 12.8。band 127k < 190k，cap 不咬合；190k 是为 emergency 的 182k 排泄留的。protect .30 < low .32，常规惰性。

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

这是第一个**可公开发布**的清理版。

## 面板诊断

```text
PANEL.md              明确说明 A/B/C/K 是插件 UI
bin/panel-check.mjs   检查 client.js、dsh.client 和 host route
```

包内已包含 client.js；看不到 tab 时先按 PANEL.md 判断是 client 未加载还是宿主缺少 sidebarRight。

## 稀疏索引审计（4.9.107）

`k` 现在不会超过实际带 vec 的记录数：

```js
const k = Math.min(points.length, Math.max(20, Math.min(60, Math.round(points.length / 50))));
```

1–19 条记录的导入/恢复索引不会再卡在“选 20 个不同中心”的循环里。

## 审计恢复、输入校验与锁（4.9.110）

```text
running:true 现在带 runningAt；超过 15 分钟自动恢复
JSON null / 缺 runningAt 的旧状态按空状态恢复
audit.lock 带 owner token；只释放自己的锁
stale 锁先 rename 到 quarantine，确认 token 后再删
拿到锁后重新检查 200 轮资格
未来 mtime 按 stale 处理
vec 必须是严格 base64、有限数、非零、维度一致
坏 vec 不推进审计游标
gate/peer/tag-confirm 选择器同时接受 legacy [闸] 与 [gate]/[peer]
```

## 深层清理（4.9.106）

```text
bc-relabel 的个人 turn/concept 探针已移除
注释中的历史日期、轮数、seq 范围已改为通用描述
event-alias-ledger / t0 / threads-core 的个人名称和过滤前缀已清理
剩余 cooldown 字样是普通英文“冷却”，不是个人名
```

## 个人示例与默认名

公开树不再包含个人示例词或个人 K 默认名：

```text
README / ARCHITECTURE 示例改为“示例主题 / 示例词”
templates 中的示例改为“示例活动 / 示例名 / 示例项目”
空 keywords.md 不再回退到任何个人/内部默认名
DEFAULT_SPECIAL_KEYWORDS 现在是空数组
```

空 K 文件仍然合法：没有默认精确名，需要用户自己写 keywords.md。

## 按 session 的 dropped-ranges

`folds.json` 仍按 `sessions/<id>` 分键，`passes.jsonl` 仍保留 `sessionId`；
`dropped-ranges.json` 改为：

```text
sessions/<sessionId>/dropped-ranges.json
```

每个文件只合并本 session 的 folds/passes。全局 `dropped-ranges.json` 不再写入，
因为不同 session 的 seq 空间不同源。

## 相对 4.9.102 的变化

```text
移除个人路径、session id、内部项目名
移除实验脚本与个人历史文档
公开树只保留运行所需的 bin/bc-relabel.mjs 和 bin/export-turns.py
新增 LICENSE / DISCLAIMER / PRIVACY / SECURITY / THIRD-PARTY-NOTICES
package.json 改为 session-scoped 描述，填入仓库/主页占位
新增 CHANGELOG
```

## 功能

```text
每个 session 自己的 A/B/C/K/rules/habits/index
band 压缩 + pass 回执
按 session 的 recall / panel
best-effort 工具路径守卫
中文 README、guides/00–05、SESSION-LAYOUT
```

## 重要限制

```text
guard 不是 OS ACL
standard preset 没有原生 recall/session_log 与 band 引擎
已启动 session 不能切 preset
改 session header 不是迁移路径
04-REBUILD：continuity preset 已验证；standard preset 未验证
```

## 责任

本软件是实验性项目，按“现状”提供。  
使用前请阅读 `DISCLAIMER.md`，备份 `~/.dsh/continuity`，并在干净 profile 先测试。

## 校验

```text
npm pack 内容物检查
无 node_modules / 无个人路径 / 无 session id
```

本公开版不附带测试脚本；上游私有仓库保留完整测试。
