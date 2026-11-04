# 07 · PTC / 子 agent / assets

这一节解决一个具体问题：

```text
长工具输出、图片、PDF、视频不要全部塞进父上下文，
但父以后还要能找回它们。
```

## 两层分工

```text
PTC / 子 agent = 执行层
  跑工具、读文件、生成图片/报表/长输出
  自己的上下文自己压缩

Continuity = 记忆层
  父 session 的 A/B/C/K、gist、assets、指针
  决定什么值得留、什么只留路径
```

不要把两者混成一个：

```text
子 agent 不要直接改父 A/B/C/K
父不要把子的 100K 原始输出整段倒回来
```

## 一次完整交接

### 1. 启动子

用 PTC workflow，或 subagent。

### 2. 子报 id

子 agent 读自己的环境：

```text
$env:DSH_SESSION_ID
```

不要猜、不要硬编码、不要用进程路径推。

### 3. 子产出

子可以：

```text
写文件到自己的工作区
生成图片/报表
跑长工具
```

大结果不要塞回父；把文件路径留下。

### 4. 子回执

固定字段：

```json
{
  "childSessionId": "session-...",
  "runId": "ptc-...",
  "status": "ok",
  "summary": "做了什么，结论是什么",
  "decisions": ["为什么这么做，拒绝了什么"],
  "open": ["未完成项"],
  "artifacts": ["C:\\...\\result.png"],
  "sourceSeqs": [123],
  "confidence": "high"
}
```

### 5. 父登记

父调用：

```text
ptc_handoff
```

它会把存在的 artifact 复制到：

```text
sessions/<parent>/assets/ptc/<run>/<child>/
```

并写一条 child 索引：

```text
mime / bytes / sha256 / 唯一 seq
```

缺失的文件进入：

```text
unresolvedArtifacts: [{ source, reason: "not-a-file" }]
artifactsResolved = false
```

不要把它当有效指针。

### 6. 父取回

```text
child_asset list
child_asset get childSessionId=... runId=... seq=1
child_asset get path=assets/ptc/...
```

父自己的图片/文件：

```text
session_asset list
session_asset get seq=...
```

`session_asset list` 只列 `owner=parent`；child 走 `child_asset list`。

## assets 布局

```text
sessions/<parent>/assets/
  index.jsonl
  parent/
    image-<seq>-<sha8>.png
    file-<seq>-<sha8>.pdf
  ptc/
    <runId>/
      <childId>/
        file-0-<sha8>.json      handoff
        file-1-<sha8>.png       artifact 1
        file-2-<sha8>.txt       artifact 2
```

同一个 handoff 内：

```text
handoff seq = 0
artifact 1 seq = 1
artifact 2 seq = 2
```

按 seq 可取；按 path 也可取。

## 图片与 read_image

4.11.3+ 支持：

```text
path-only image -> stat 补 bytes
attachmentId -> .dsh/attachments/v1/objects/<sha>
```

所以 `read_image(path)` 返回的图通常能直接进入模型，而不是 handle。

仍然无法内联的：

```text
只有 name/size
没有 path/data/attachmentId
```

## 旧 index

4.11.5 之前写的行可能是：

```text
mime = null / ''
seq  = 0（同 run 多条）
```

读取端必须容忍：

```text
不要断言 mime 非空
不要断言 seq 唯一
歧义时用 path 取
```

## 不要这样测资产

```text
备份 -> compact -> restore
```

restore 会连同 compact 期间写的 assets 一起回滚；  
看起来 assets=0，其实是测试方法把证据抹掉了。

正确测试：

```text
新 session / 不 restore
先发图或让子产出 artifact
/compact 或自然 fold
session_asset list / child_asset list
```

## 最小验收

```text
1. 子能报 DSH_SESSION_ID
2. ptc_handoff 返回 child marker
3. assets/ptc 下真有文件
4. sha256 与源一致
5. child_asset get 按 seq/path 命中
6. artifactsResolved=true 或明确 unresolved
7. 父不靠原始输出也能继续
```

## 一句话

```text
子负责把活干完并把指针交回；
父负责把指针变成可追回的资产；
两边都不把大输出塞进父上下文。
```
