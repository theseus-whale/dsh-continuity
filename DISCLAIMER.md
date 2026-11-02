# 责任声明 / Disclaimer

本软件是实验性的个人项目，不是 DeepSeek 官方产品。

## 中文

本软件按“现状”（AS IS）提供，不附带任何明示或暗示的保证，包括但不限于：

```text
可用性
适销性
特定用途适用性
不侵权
数据不丢失
与其他 DSH 版本兼容
```

使用本软件即表示你理解并自行承担以下风险：

```text
它会读写本机的 ~/.dsh/continuity 和 session 相关文件
它可能压缩、摘要、重写或移动会话上下文
它可能注入 role=user 的消息
它的工具守卫不是操作系统级安全边界
错误配置、其他插件、操作系统或模型行为都可能造成数据丢失
```

在用于重要或不可替代的数据之前，请：

```text
备份 ~/.dsh/continuity
先在干净 profile 测试
不要在没有备份的生产环境直接启用
```

作者和贡献者不对因使用或无法使用本软件造成的任何直接、间接、附带、特殊或后果性损失承担责任。  
如果你不接受这些条件，请不要安装或使用本软件。

## English

This software is an experimental personal project, not an official DeepSeek
product. It is provided "AS IS", without warranty of any kind, express or
implied, including merchantability, fitness for a particular purpose,
non-infringement, availability, or data preservation.

It reads and writes local continuity/session files, may compact or summarize
conversation context, may inject user-role messages, and its tool guard is not
an OS security boundary. Back up `~/.dsh/continuity` and test in a clean profile
before using it with important data.

The authors and contributors are not liable for any direct, indirect,
incidental, special, or consequential damages arising from use of, or inability
to use, this software.
