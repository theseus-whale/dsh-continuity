# Security

## 报告问题

请不要在公开 issue 中贴出：

```text
API key
完整 session 内容
个人路径
可复现的隐私数据
```

报告时给出：

```text
版本
操作系统
复现步骤
错误文本
最小化的目录结构
```

## 威胁模型

这个插件不是沙箱。它运行在 DSH 宿主进程中，可以：

```text
读写 ~/.dsh/continuity
读取配置的 session 日志
注册宿主路由
注入 role=user 消息
```

`src/session-guard.mjs` 是 best-effort 工具路径守卫，不是 OS ACL。  
拥有完整文件权限的代码或插件可以绕过它。

## 公开部署注意

```text
peer 路由只监听 loopback
不要把 DSH Web 端口暴露到公网
不要在共享机器上把 ~/.dsh 交给不受信任的进程
安装第三方 bundle 前先读源码
```

## 依赖

```text
Node.js >= 22
DSH 宿主提供的 peer dependencies
本地 ONNX 模型
```

本包不包含安装脚本，不执行 postinstall。
