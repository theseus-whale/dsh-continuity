# 发行说明 — 4.9.106-safe.1

日期：2026-11-03

这是第一个**可公开发布**的清理版。

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
