# 隐私说明 / Privacy

## 数据存在哪里

```text
~/.dsh/continuity/
~/.dsh/sessions/
```

本插件在这些目录中保存连续性索引、A/B/C/K 表、规则/习惯、审计提示和压缩记录。  
这些数据默认只留在本机，不会由本插件上传到作者控制的服务器。

## 不会做什么

```text
不收集遥测
不上传 session 内容
不内置作者服务器地址
不要求你提供 API key
```

## 会做什么

```text
读取当前 session 的对话和索引
把必要内容交给 DSH 配置的模型做摘要/投影
使用本地打包的 BGE 模型做离线向量
在 loopback 上提供 peer/面板路由
```

模型调用由 DSH 的当前 provider 处理；它适用的隐私政策取决于你配置的模型服务商，而不是本插件。

## 本地模型

```text
models/Xenova/bge-small-zh-v1.5
```

模型随包提供，文本不离开本机。模型权重保留其上游许可证。

## 删除数据

停止 DSH 后删除：

```text
~/.dsh/continuity/sessions/<sessionId>/
```

或删除整个 `~/.dsh/continuity`（会丢失所有 session 的连续性数据）。  
删除前请备份。
