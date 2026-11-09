# SPEC 0.4.5：save 的 T 边界、并回默认、header 显示

> **Historical (0.4.5).** 当前版本请读 `README.md` 和 `docs/ARCHITECTURE.md`。

## 背景

0.4.4 让默认 save 不再跨到更早的 T，但实现取的是“当前 tag run 的起点”。T3 被 T2/T0 的 override 切成 33 个 run，结果是默认 save 只收了 5 条（797 tokens），而规则要的是“一次一个 T”。

实测回执：

```
saved as t-mvr1fbjr-4edcf64b · new · seq 12425..12431 · 5 条 · 797 tokens
```

同一轮还有个副作用：没传 `threadId` 时它新建了线头，而规则要求“拿不准就并回”。

## 改动一：`minStartSeq` 用 dominance block，不用 run

文件：`src/threads.mjs`，`selectSaveRange()`（约 341 行），尤其是 `minStartSeq` 的 clamp（约 394 行起）。

现在调用方传的是“包含末尾节点的那个 tag run 的起点”。改为传“dominance block 的起点”：

1. 从 `endIdx` 往回走 `tags.runs`（按 run 粒度，不是逐 seq）；
2. 当前 T 自己的 run：直接并入；
3. 别的 T 的 run，长度 ≤ `islandMax`（建议 5）：当作 override 岛，跨过去；
4. 别的 T 的 run，长度 > `islandMax`：停，起点就是它之后那条 run 的起点。

这样默认 save 能收满 `MAX_SAVE_MESSAGES`（200），又不会跨进上一个真正的 T。

调用方：`src/engine.mjs` 的 `prepareSave()`（约 677 行附近，现在算 `minStartSeq` 的那几行）改成调用 `threads.mjs` 里新增的 `dominanceStartSeq(tags, endSeq, { islandMax })`，由 `threads.mjs` 导出。

## 改动二：默认并回当前 T 的线头

文件：`src/engine.mjs`，`prepareSave()` 里决定 `mode: 'new' | 'append'` 的那段（约 697–709 行）。

规则：

- 没传 `threadId`：
  - 当前 T 绑定了线头（`threads` 里 `alias` 或 `id` 等于当前 tag 的规范化 id）→ **append**，`segment = existing.segments.length + 1`；
  - 当前 T 是 `T0`，或没有绑定线头 → **new**；
- 传了 `threadId`：维持现状。

`active:false` 不应该影响这个判断——“这条线收过”不等于“不能再并一段”。

另外：**新建的线头要自动标到当前 T**（T0 除外）。现在新建后它没有标签，所以下一轮的 `[标签]` 会显示“T 未定 · 另有 N 条”。

## 改动三：header 只显示主 T

文件：`src/tags.mjs`，`tagCoverageForRange()` 结尾生成 `label` 的那几行（约 147–154 行）。

现在：

```js
const visible = items.slice(0, 3).map((item) => item.display);
label = `${visible.join(',')}${extra > 0 ? `,+${extra}` : ''}`;
```

问题：`display` 是 `alias ?? label ?? 短 id`，所以主 T 显示成 `T3`、次 T 显示成 `Coo 的形象`，两种写法混在一起，读起来像“这段同时属于两个 T”。

改为：

- 主 T 显示 `item.display`（alias 优先）；
- 还有别的 T 时加计数：`T3 +2`；
- 只有一个 T：`T3`，不加 `+0`。

`display` 本身不用改；改的只是 `label` 的拼法。

## 验收

1. 在当前 T3 上直接 `save`（不传 `threadId`、不传 from/to）：
   - 回执 `mode: "append"`，`id` 是 T3 的线程 id，`segment` 递增；
   - `count` 接近 200（或到上一个真 T 为止），不是 5、不是 797 tokens。
2. 同一段里若含 T2 的小岛（≤5 条），不回退到 5 条，也不把 T2 岛算成边界。
3. `save` 在 `T0` 上仍然 `mode: "new"`。
4. `save` 之后下一轮 gist header：主 T 只有一个时是 `T=T3`；有别的 T 时是 `T=T3 +2`。
5. 传 `threadId` 的旧用法不变；`fromSeq/toSeq` 显式传入时不受 `islandMax` 影响。
6. 新建的线头（T0 除外）自动带当前 T，`[标签]` 不再出现“T 未定”。

## 不做

- 不改 gist 正文格式、不改 rules 注入、不改 fold 本身。
- 不为“跨 T”自动拆成多次 save——那是我自己的判断，引擎只保证默认不跨。
- 不改 `T0` 的语义。
