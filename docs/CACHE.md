# Cache-first context maintenance

> **Historical.** 当前 band/floor 行为以 `docs/ARCHITECTURE.md` 和 `src/policy.mjs` 为准；本文的旧数字/策略不作当前契约。

The goal is not “small drops”; it is **few prefix rewrites**. This note explains why, measures the
current Continuity session, and records the policy that follows from it.

## 1. Why every compaction invalidates the suffix

The provider's prompt cache is prefix-addressed: a request is a hit only up to the first token that
differs from a cached request. A compaction replaces an old span with one summary user message at
the **start** of that span. Everything before the span (system prompt, tool schemas) is unchanged;
everything after the replacement now has a different prefix, so the entire suffix misses on the
next request and must be re-read/re-cached.

Therefore:

- **Pass count is the cost**, not pass size. Twenty 4k passes invalidate twenty times; one 190k
  pass invalidates once.
- A small pass is the worst case: it removes little but still pays a full suffix re-read.
- Compaction cannot be made cache-transparent while it removes surface nodes. The only lever is to
  do it rarely and do enough at once.

## 2. Measured evidence from the Continuity session

Session `session-example` (preset `continuity`, log decoded read-only):

| Metric | Value |
|---|---:|
| summary compactions | **53** |
| total shadowed tokens | **698,108** |
| average pass | 13,172 |
| largest pass | 100,725 |
| one-node passes | 34 |
| passes under 10k | 47 |
| passes 50k–150k | 6 |

The old policy (`setpoint 0.65 / high 0.80 / low 0.55 / maxPerBatch 8k / minAction 4k`) capped every
high pass at 8k. Draining from 80% to 55% is ~198k, so it took ~24 passes — and because the selector
stops before a node that would exceed the budget, many passes removed a single ~3.4k node. That is
the 21 “band-high single message” passes plus emergencies.

The cache cost is visible in the provider usage of two adjacent requests:

```
request A:  inputTokens 659     cacheReadTokens 733,184   (99.91% cached)
   ... compaction (one 4k node + summary) ...
request B:  inputTokens 733,414 cacheReadTokens 8,704     (1.2% cached)
```

A 4k-token reduction forced a **733k-token prefix re-read**. This is why lifetime cache hit rate is
the wrong metric: 53 such events dilute it. Look at the per-request `cacheReadTokens` between two
compactions instead.

## 3. The policy that follows

`src/policy.mjs` now exports `CACHE_FIRST_POLICY` (the default), with `W = messageBudget`:

| Field | Value | Tokens at W = 792,576 |
|---|---:|---:|
| `setpoint` | 0.60 | 475,546 |
| `high` | 0.60 | 475,546 |
| `low` | 0.40 | 317,030 |
| `emergency` | 0.65 | 515,174 |
| `emergencyTo` | 0.42 | 332,882 |
| `maxPerBatch` | 190,000 | — |
| `minAction` | 24,000 | — |
| `protect` | 0.30 | 237,773 |

`setpoint` **equals** `high` on purpose. Above high, one pass computes
`est − low × W` (≈158k at the crossing) and the 190k cap lets it land at low. The context then
swings between 40% and 60%; there are no 24k proportional passes in between. The optional
`CACHE_GRADUAL_POLICY` keeps `setpoint 0.50` for a smoother average context, but every 24k pass it
adds is another prefix invalidation.

`emergencyTo` is **below high** on purpose. With the old 0.88, a 97% overshoot emergency-landed at
88% (697,467), still above high, so the next batch immediately ran a second band-high pass: two
prefix invalidations for one overshoot. 0.2.7 lands at 42% (332,882), leaving 18 percentage points
below high 60% (475,546); exactly 65% still takes one band-high, and >65% takes one emergency.

Expected pass count for the same 698,108 tokens removed:

```
698,108 / 158,515 ≈ 4.4  →  5 passes
```

That is the 53 → 5 reduction, without shrinking the protected tail or touching the raw archive.

### What stays fixed

- **system + tools prefix**: never compacted; the engine starts at the oldest non-system node.
- **protected tail**: 30% of W (237,773) is never folded; the low water mark (62%) is above it.
- **gist pointer / raw archive**: the summary still carries
  `[gist · log:<session>#seq=<start>-<end> · N messages · original retrievable]`; the original log
  events remain at those seqs.

### What it costs

- One large summarization call per pass (~190k input, a few k output).
- The context oscillates over a 24% band instead of hovering near a setpoint.
- The first request after a pass is a cache miss from the replacement onward; later requests hit
  again. The win is fewer such first requests.

## 4. How to verify

1. In the Web UI's performance usage, read per-request `cacheReadTokens` / `inputTokens`; do not
   compare lifetime percentages.
2. A pass is followed by one low-hit request; subsequent requests should return to high hits.
3. The Continuity panel's “Recent passes” list records each pass (range, tokens, reason, time).
   Compare the interval between passes before/after the policy change.
4. The expected signal: pass count drops from ~53 to ~4 for the same session growth; the total
   tokens removed stays similar.

## 5. Applying it to a live session

The policy is read when the engine mounts. An already-running session keeps the revision it started
with, so either:

- restart DSH and resume the Continuity session with the updated preset (`preset-continuity` pins
  `setpoint 0.86` and inherits the rest of `CACHE_FIRST_POLICY`), or
- fork the session; the child mounts the current preset and inherits the history, or
- remount the bundle. In this run a plugin-manager `set_plugin` toggle remounted the preset and
  applied the pinned cache-first policy live at 18:27:37 (`engine.policy` 0.86/0.86/0.62,
  190000/24000/0.30). The JS-module cache still means a full restart is needed for code-only
  changes such as the cold-start route fix.

The parent session's 53 old summaries remain as gists; the next high crossing under the new policy
is the first large drain. Its pass record (reason `band-high`, budget 190000) is the first
cache-first observation.

## A4/B in 0.2.4

A4-safe previews only old, non-active `tool/result` text as the first stage of a compression whose
target is **low 62%** (`emergencyTo` 80% for an emergency), not merely `high` 86%. If the preview
cannot cover the whole gap it is still applied, and the remaining pass continues to the target even
when the estimate is already below high. This is deliberately different from 0.2.2, which stopped
after previewing to high: that left the context hovering at 86% and caused the repeated prefix
invalidations the 190k band is meant to avoid. One high crossing now produces one 24%-W band; the
oldest user/reasoning is folded only when the tool previews cannot reach 62%, and active pins stay
full. The summary-view (B) preview changes only the summarization input, never the surface or cache.

0.2.4 adds a 3-turn active window (old unmatched calls no longer pin), non-text handles that keep
the payload out of the main context (one optional auxiliary semantic call; deterministic fallback),
and an overflow-only active pause. The pause is the only path that can detach an active result; it
does so only when that result is large enough to explain the measured overage. Raw stats may
double-count summary + replacement; that overlap is archive-only, not context.

0.2.5 adds no policy change. It makes A4 skip `[tool result handle]` / `[continuity pause]` /
existing previews (no second preview of a handle), measures the surface after each pass and records
`afterTokens`/`afterSurfaceTokens`/`rebloatTokens`, and labels a manual `/compact` with a gist header
plus a `manual` pass record. The manual cut remains the base command's depth.

0.2.6 introduced the 515k hard cap. 0.2.7 tunes the ratio to high 0.60 (475,546; 45.4% full),
low 0.40 (317,030; 30.2%), emergency 0.65 (515,174; 49.1% full) → emergencyTo 0.42 (332,882; 31.8%).
The high→emergency gap is 5% W (39,628), above `minAction` 24k; 0.62/0.65 was only 3% (23,777), below
it. `emergencyTo` is below high, so it cannot chain into band-high. `protect`, `maxPerBatch`, and
`minAction` are unchanged.

0.3.0 adds threads without changing the band policy. The active/rules line is a `user/message`
appended after the surface tail once per turn; it is never part of the system/tool prefix, so the
static cache prefix is unchanged. The active thread's `loadSeq` is a hard pin: `oldestRange()` uses
it as the tail floor, so automatic compaction cannot fold the loaded quote. A save clears
`activeId`; the old quote becomes foldable. Save/load commits are deferred to the next pre-step,
outside the tool call/result pair.

0.3.1 changes injected messages to `source: { kind: "user" }`. The v4 format rejects an
unregistered `plugin` source kind; the line/load/manual/semantic messages are context, not
compaction checkpoints, so `user` is the correct producer-owned kind. The gist replacement keeps the
base `compact` checkpoint source.

0.3.2 moves that to `{ kind: "runtime-context", form: "snapshot", sections: [...] }`, which v4
accepts and the UI renders as a context block rather than a human message. It also removes the
post-gist `compaction/prune`; the summary's own `shadowedTokenCount` is the price, and a prune after
the replacement names a shadowed span. No post-replacement prune means no v4 surface corruption.

0.3.3 keeps one injection per turn (not per step) and prefixes the rules with an attribution:
they are the instance's own `rules.md`, not a new user instruction or system requirement, and may
be ignored or rewritten. The block is appended after the tail; the static prefix is unchanged.

0.3.4 adds `thread.segments[]` and optional `save.threadId`. Append is explicit: the engine never
guesses affinity. `list`/`active` display `segments`/`lastAt`; load quotes the latest segment with
`第N/M段`; old one-range state normalizes on read and is rewritten with segments on the next write.
Thread-level totals/`next` follow the latest segment, so the active line and load header stay small.

0.3.5 adds `scan` (read-only, non-injecting, reasoning-free heads, synthetic context skipped, <900
token payload) and range/select load (`fromSeq`/`toSeq`, `select`, `segs`). The static prefix is
untouched; scan writes nothing and load still queues its quote for the next pre-step.

0.3.6 adds the `tags.json` sidecar (overrides → last run → T0), find/tag/retag/tags, scan-by-seqs,
and tag/seqs load (earliest 3 + latest 5, `segs`). No `[TX]` enters the raw log; the auto-tagger
writes one run per completed turn into the sidecar only.

0.3.7 keeps active only for thread loads; tag/seqs loads append a quote without moving `[线]`.
find(T0) returns complement ranges; find bounds are strict; tags() carries display/count/active;
tag accepts a label; receipts dedupe the display name; updatedAt advances.

0.3.8 tag ranges append one run instead of hundreds of overrides; find exposes coverage
ranges/covered; untag writes a T0 run and clears overrides in the interval. No auto-merge, no raw
change, no save change.

0.3.9 tags() rows split entries (runs+overrides) from events (actual resolved coverage); count is
an alias of events. The coverage pass uses max(session seq, runs, overrides); no other behavior changes.

0.4.0 adds T= to gist headers, folds.json visible/folded plus load annotation, thread aliases,
generated tags.md with keywords, tag load first/last, and a slim [标签]/[习惯] per-turn block. No
save/load segment semantics changed.

0.4.1 allows tag metadata-only (label/keywords/alias), tag alias sets the matching thread alias,
tags() display uses alias first. find(T0) remains the full complement.

0.4.2 unifies T0: tags().T0.events is the complement and equals find(T0).count; other tags match
find().covered; tags.md uses the same. Gist T= uses display, omits T0 unless all T0, max 3 plus +N.

0.4.3 treats alias as display only: auto/find/load/tag writes use canonical thread id, alias resolves,
and alias-named tags migrate into the canonical tag. find count = total coverage (incl folded), seqs =
page, covered = count.

0.4.4 default save clamps its start to the current T run start (explicit from/to untouched); gist T
is primary display + secondary non-T0 event count, e.g. T3 +2; no multi-tag list.

0.4.5 replaces the run start with a dominance block (own runs join; other-T islands <=5 cross; larger
other stops). Default save appends to the thread bound to the current T; a new non-T0 thread inherits
the current T alias and is active.

0.4.6 load withReasoning: chronological body + paired reasoning, one 16k budget, 800-token reasoning
truncated to 150 head + 650 tail, receipt reasoningInjected/reasoningTokens/skipped. Default 8k load,
gist, and scan unchanged.

0.4.7 adds explicit delete with deleted/ backup, header segment/token/activity counts, save relabel
protection, tag/retag alias id resolution with unknown-tag-id, and drops zero-event tags.md rows.























