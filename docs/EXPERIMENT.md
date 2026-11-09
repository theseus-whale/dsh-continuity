# Config-only experiment — `thresholdRatio 0.92` / `retainRatio 0.5`

> **Historical.** The experiment is preserved for the record. Current band policy and reachable
> floor are in `docs/ARCHITECTURE.md` and `src/policy.mjs`.

This is the first experiment from `CREATOR-HANDOFF.md` (“Config-only quick win”): change the
shipped compaction backend's policy without changing engine code, and see whether a 50% verbatim
tail and a 92% cap already feel like the band.

## Where it lives

A patch **cannot** target the live engine on this profile. The effective `compaction-basic` is a
child of the `standard` preset:

```
include:preset-standard
└─ group "compaction"   isolate: { compaction: true, toolResultPruner: true }
   └─ child "compaction-basic"
```

`Config.listConfigs` addresses top-level rows only, and the nested id
`include:preset-standard:compaction:compaction-basic` is not a loader entry. Overriding
`preset-standard` would change the default backend for every new session, which the handoff
explicitly says not to do first.

So the experiment is shipped as a **copy of the standard preset** whose only difference is the
compaction child's `config`:

| Item | Value |
|---|---|
| Loader row id | `include:preset-band` |
| Declaration `config.id` | `band` |
| Display name | `Band (config-only)` |
| Order | 20 |
| Shipped `preset-standard` | untouched |
| Rollback | pick another preset, or remove the `dsh-continuity` bundle |

The exact override, inside the copied `compaction` group:

```yaml
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  config:
    thresholdRatio: 0.92
    retainRatio: 0.5
    # headroomTokens omitted: the shipped default 65536 applies and the
    # resolved threshold is min(W × 0.92, W − O − 65536).
```

Nothing else in the 22-plugin preset list changes. `command-compact` and `tool-result-pruner` stay.

## Resolved numbers (live model route)

`cordis_inspect_query` / `ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-flash')`:

| Input | Value |
|---|---|
| `contextWindow` | 1,048,576 |
| reserved completion tokens (header `maxTokens`) | 256,000 |
| `messageBudget = W − O` | 792,576 |
| `headroomTokens` | 65,536 |

Reported by the panel's projection and computed with the base backend's own formulas:

| Config | `thresholdTokens` | `retainTokens` | one pass at the threshold |
|---|---|---|---|
| shipped `0.8 / 0.16` | 727,040 | 126,812 | 600,228 |
| **experiment `0.92 / 0.5`** | **727,040** | **396,288** | **330,752** |
| band engine (reference) | triggers at 515,174 | protects 221,921 | small slices, ≤ 8,000 |

The 92% ratio is not the binding cap: `0.92 × 1,048,576 = 964,690`, but
`1,048,576 − 256,000 − 65,536 = 727,040`. The experiment halves the retained tail (126,812 →
396,288) but keeps the same trigger point, so each cut is still one large cliff (~331k tokens).

## Why that still matters

Seven real summary compactions found in the local session logs (read-only scan; see
`docs/API-NOTES.md` §6) shadowed:

| session | shadowed tokens | shadowed surface nodes | summary maxTokens |
|---|---:|---:|---:|
| `session-2f831fa2…` | 363,912 | 1,259 | 65,536 |
| `session-2f831fa2…` | 354,500 | 1,166 | 65,536 |
| `session-2f831fa2…` | 342,756 | 1,000 | 65,536 |
| `session-4185b80f…` | 425,772 | 804 | 8,192 |
| `session-f1ac062b…` | 442,443 | 587 | 65,536 |

Full record for the first one:

```
compactionId  b57ba840-1892-4175-b652-06c7e30b8609
start         seq 8255
summary       seq 8257   shadowedRange 4424–7043   363,912 tokens
replace       seq 8258   surfaceOp replace 4424–7043
end           seq 8259
```

The experiment changes *how much recent history survives* the cliff; it does not remove the cliff.
If the 50% tail already feels right, the custom engine is not worth its cost. If the single 331k
drop is still too disruptive, the `continuity` preset is the next step.

## How to run it

1. Start a **new** session (existing sessions keep the preset revision they started with).
2. Pick the preset **`Band (config-only)`**. It appears beside `standard` in the preset control.
3. Work normally until the session crosses the threshold. Automatic compaction happens at a step
   boundary; the conversation shows the usual compaction row.
4. To see the numbers rather than feel them, open the **Continuity** sidebar panel: the
   “Config-only projection” card recomputes the table above from the live route and model.
5. Compare a `Band` session's compaction row against a `standard` session's row (template below).

The panel's “Recent passes” list only observes the **continuity engine**, not the shipped backend;
a Band pass is visible in the session's compaction row and its log (`compaction/start`,
`compaction/summary`, replacement `user/message`, `compaction/end`).

## Decision gate

- **Feels acceptable** → keep using `band`; the custom engine is optional. Rollback to `standard`
  is one preset selection.
- **Still a cliff** → use `continuity`: same preset list, but `dsh-continuity/engine` replaces
  `compaction-basic`, labels every pass with a gist pointer, and (since the cache-first update)
  does one ~190k drain per high crossing instead of many small passes.
- **Something breaks** → remove the bundle (`plugin_manager` `remove_bundle`, target
  `dsh-continuity`) and select `standard`. `preset-standard` and its compaction backend were never
  modified, so no session needs repair.

## Status

- 2026-10-26: `include:preset-band` registered and active on the desktop profile; the resolved
  arithmetic is valid (`396,288 < 727,040`).
- No session has crossed the band threshold yet. The `compactionId` of the first Band pass will be
  recorded here (or in `docs/API-NOTES.md`) once it happens.
- 2026-10-26 (later): the `continuity` engine's old policy produced 53 passes in
  `session-0b094f6e…` (698,108 tokens total, 34 one-node passes) and repeatedly wiped the suffix
  cache. `continuity` now uses `CACHE_FIRST_POLICY` (86/62, 190k per pass, 30% protected); see
  `docs/CACHE.md`. The config-only `band` preset in this document is unchanged.
