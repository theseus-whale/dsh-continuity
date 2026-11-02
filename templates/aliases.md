# Query-side aliases for the literal layer.
# Format: user term => alias / alias
# Only manual recall() expands aliases; pre-step does not.
# Alias matches are weighted 0.6; direct matches 1.0. At most 3 expansions/query.
#
# 通知 => notification / post_notifications
# 权限 => permission
# 短信 => sms / read_sms
# 脚本 => script
# 流量 => traffic / quota / dataplan
# 买 => buy
