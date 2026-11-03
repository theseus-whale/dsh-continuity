# 06 — vec / embedding 没跑起来

## 1. 症状

```text
A/B/C/K 有内容
面板正常
但审计不来
bc-index.jsonl 里 vec 为空
```

这不是 A 表的问题。  
这是**索引里的向量没有生成**。

## 2. vec 是干什么的

B 的标签可以用概念词算，但审计要做聚类：

```text
把很多轮按语义放进不同的簇
看哪个簇和现有 A 都不太像
```

聚类需要：

```text
bc-index.jsonl 的 vec
```

**比如这种情况：**

```text
如果 vec 为空，
则审计没有可聚类的点，
会报 "audit needs vec on at least 90% of records"。
```

## 3. 为什么 pnpm 会跳过

本地 embedding 用：

```text
@huggingface/transformers
onnxruntime-node
```

pnpm 默认可能不执行依赖的 install/postinstall 脚本。

**比如这种情况：**

```text
如果 pnpm 跳过了 onnxruntime-node 的构建，
则 transformers 加载模型时会失败，
新记录的 vec 就会是空。
```

## 4. 先自检

在安装目录运行：

```powershell
cd <dsh-continuity 安装目录>
node bin\vec-check.mjs
```

成功应该看到：

```text
{ "ok": true, "dimensions": 512, ... }
```

失败会输出类似：

```text
embedding runtime unavailable ...
```

## 5. 修复 pnpm 的 build 跳过

在 DSH profile 目录（不是工作区）执行：

```powershell
pnpm approve-builds
```

在列表里允许：

```text
onnxruntime-node
sharp
```

然后：

```powershell
pnpm rebuild onnxruntime-node sharp
```

再跑一次：

```powershell
node bin\vec-check.mjs
```

如果 `ok: true`，embedding 恢复了。

## 6. 已有空 vec 的记录怎么办

不要删索引。

先备份，然后回填：

```powershell
$s = 'C:\Users\...\sessions\<sessionId>'

node bin\bc-relabel.mjs --vectors `
  --index "$s\bc-index.jsonl" `
  --turns "$s\turns.jsonl" `
  --out "$s\bc-index.vec.jsonl" --write
```

这会把旧记录缺的 `vec`/`chatter` 补上。

## 7. 然后审计才会运行

```text
vec 恢复
-> 审计有聚类点
-> 下一次达到 200 轮阈值时才会执行
```

**比如这种情况：**

```text
如果已经 507 轮，但 audit-state.lastAuditTurn 已经接近 507，
则修好 vec 后不一定立刻触发；
要等下一次满足阈值，或手动调整/重建审计状态。
```

## 8. 一句话

```text
A/B/C/K 有，不代表 vec 有。
vec 空，审计就不工作。
vec 空通常不是规则问题，是本机 onnxruntime 没构建。
```
