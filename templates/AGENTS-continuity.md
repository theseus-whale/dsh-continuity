# 合并进 AGENTS.md 的片段（不要整份替换 AGENTS）

## Continuity 的规则层

- `~/.dsh/continuity/rules.md` 是 Continuity 自己的硬规则：必须读当前内容；缺失要报告。
- `~/.dsh/continuity/habits.md` 是 Continuity 自己的软偏好：相关时读；与 rules 冲突时 rules 胜。
- rules/habits 允许实例修改；AGENTS.md 不由实例修改。
- 不得把 rules 的硬约束下放到 habits，也不得用 habits 覆盖 rules。
- AGENTS 只引用，不复制 rules/habits 全文。
