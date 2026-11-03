# A/B/C/K 面板排错

A/B/C/K 不是 DSH 原生功能，是本插件注册的 UI：

```text
左侧栏“连续性”面板
右侧栏“A/B/C/K 标签”tab
```

## 1. 先确认包里有 UI

```text
client.js
package.json -> dsh.client.platform = "web"
```

4.9.110+ 的 tgz 都带。

## 2. 连“连续性”入口都没有

说明 client 没加载，不是表为空。

按顺序检查：

```text
1. 装的是 dsh-continuity-*.tgz，不是只解压了 zip
2. 装进了当前使用的 profile
3. 安装后重启了 DSH
4. 当前 DSH 版本支持 sidebarRightTabs / sidebarRight
5. 浏览器刷新一次
```

可以运行诊断：

```powershell
node bin\panel-check.mjs --url http://127.0.0.1:<当前端口>
```

它会告诉你：

```text
包版本
client.js 是否存在
dsh.client 是否声明
/dsh-continuity/state.json 是否能访问
```

## 3. 左侧有“连续性”，但右侧没有 ABCK

先在左侧面板里点：

```text
A / B / C / K 记忆标签
```

它会尝试调用：

```text
sidebarRight.openTab("continuityTags")
```

如果提示“右侧栏服务不可用”，说明当前 DSH 版本没有 `sidebarRight` API，面板 tab 注册不了。

## 4. 有 tab，但打开是空表

正常：

```text
新 session 的 A/C/K 从空开始
B 从自己的第一轮开始
```

先发一轮消息，让 pre-step 建索引；面板会从：

```text
还没有 B 索引
```

变成：

```text
A/B/C/K 空表
```

## 5. 给对方的准确话术

```text
A/B/C/K 是插件的右侧栏 UI，不是 DSH 自带。
如果连“连续性”都没有：插件 client 没加载，检查安装/重启/DSH 版本。
如果有“连续性”但没有 ABCK：DSH 缺少 sidebarRight API。
如果 tab 打开是空表：正常，先发一轮消息。
```
