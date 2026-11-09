# API notes — what the adapter still needs

> **Historical.** Research notes from an older `0.2.x` host. Current architecture is in
> `docs/ARCHITECTURE.md`; do not use these paths/APIs without re-checking the live host.

Researched from the public npm type declarations, not from the running host. The runtime may be a
newer `0.2.x`; pin peers before publishing.

Sources:

- [`@deepseek-ai/dsh-compaction` 0.2.1-rc.3 `index.d.ts`](https://unpkg.com/@deepseek-ai/dsh-compaction@0.2.1-rc.3/lib/types/index.d.ts)
- [`@deepseek-ai/dsh-compaction` `types.d.ts`](https://unpkg.com/@deepseek-ai/dsh-compaction@0.2.1-rc.3/lib/types/types.d.ts)
- [`@deepseek-ai/dsh-compaction-basic` `index.d.ts`](https://unpkg.com/@deepseek-ai/dsh-compaction-basic@0.2.1-rc.3/lib/types/index.d.ts)
- [`@deepseek-ai/dsh-compaction-basic` README (zh)](https://unpkg.com/@deepseek-ai/dsh-compaction-basic@0.2.1-rc.3/README.zh.md)

## The seam

```ts
abstract class CompactionEngine extends Service {
  abstract compactIfNeeded(
    agent: CompactionAgentContext,
    trigger: 'pressure' | 'context-overflow',
    signal: AbortSignal,
  ): Promise<CompactionResult | null>;

  abstract compactNow(
    agent: ManualCompactAgentContext,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null>;

  abstract compactRegion(
    start: SessionSeq,
    end: SessionSeq,
    agent: CompactionAgentContext,
    signal?: AbortSignal,
  ): Promise<CompactionResult>;
}
```

A successful run replaces the selected surface span with **one summary user message**. The
transaction writes `compaction/start` → `compaction/summary` → replacement `user/message` →
`compaction/end`. Edges must be balanced (`toolPairingBalancedBefore` / `After`). The system
message at surface position 0 is never shadowed.

## Why extend the basic backend

`@deepseek-ai/dsh-compaction-basic` already implements the expensive parts:

- `BasicCompactionEngine` (subclass of `CompactionEngine`);
- token-meter-driven pressure and overflow recovery;
- range selection, retention, durable marker transaction;
- `summarize()` as the sole subclass hook;
- public `compactRegion(start, end, agent, signal)`.

So the skeleton subclasses it and only overrides `compactIfNeeded` to choose **smaller ranges**
than the base policy would. `compactNow` and `compactRegion` stay inherited.

Its config (all optional):

| Field | Default | Meaning |
|---|---|---|
| `thresholdRatio` | `0.8` | trigger at `floor(min(W × ratio, W − O − headroom))` |
| `headroomTokens` | `65536` | extra margin beyond output reserve |
| `retainRatio` | `0.16` | recent verbatim budget as a fraction of `W − O` |
| `retainTokens` | — | absolute form, mutually exclusive with `retainRatio` |
| `maxTokens` | headroom | summary output cap |
| `auto` | `true` | automatic pressure + overflow recovery |
| `modelPolicies` | `[]` | per-`{provider,model}` overrides |

## The two missing pieces

### 1. `measure(agent)`

Need the used and window tokens for the agent's latest routed request from `ctx.tokenMeter`. The
README describes the semantics (singleton meter, latest durable routed envelope, fixed estimator)
but not the call signatures. Inspect with Creator mode:

```
cordis_inspect_list
cordis_inspect_query  → the token-meter provider's methods/types
```

### 2. `oldestRange(agent, budget)`

Need to walk `agent.session`'s surface, skipping the system node at position 0, accumulate nodes
until `budget` is reached, then move the end back to a balanced boundary. The exported helpers:

```ts
toolPairingBalancedBefore(session, startNode): boolean
toolPairingBalancedAfter(session, endNode): boolean
```

Return `{ start, end }` as surface seqs (inclusive), or `null`. If `null`, fall back to
`super.compactIfNeeded(...)` so the session still compacts at the base threshold.

## Provenance: quiet, not silent

The fixed checkpoint preamble is an **event marker**; the provenance header is a **property of the
memory**. Both can coexist:

- `gistHeader({ sessionId, startSeq, endSeq, count })` produces
  `[gist · log:<session>#seq=<start>-<end> · N messages · original retrievable]`.
- `annotateSummary(blocks, header)` prepends it to the first text block of the summary.
- `SYSTEM_CONVENTION` goes into the system prompt **once**; it explains the tag and the fallback
  ("say you only remember the gist").

The intended `summarize()` override:

```ts
protected async summarize(input, agent, signal) {
  const base = await super.summarize(input, agent, signal);
  const header = this.pendingHeader;
  this.pendingHeader = null;
  if (!header) return base;
  return { ...base, summary: annotateSummary(base.summary, header) };
}
```

Unknowns to confirm at runtime:

- the exact field of `SummaryResult` holding the blocks (`summary` is the guess);
- whether a `ctx.systemPrompt.section({ name, order, interpolate: false, text })` seam exists
  (the `dsh-soul` plugin uses that shape) and where to mount it so it is not itself compacted;
- whether the preamble can be shortened without reimplementing the replacement transaction.

Test for the failure this prevents: ask about a detail that exists only in a compacted range. The
expected answer is "I only have the gist; the original is at `log:…#seq=…`", not a confident
fabrication.

## Hard constraints

- **One engine per context.** `ctx.compaction` holds exactly one implementation. A plugin must
  **replace** the existing `compaction-basic` row, not insert a second one.
- **`compactRegion` needs an open turn**; `compactNow` reserves an idle agent instead.
- **Every pass is an LLM call.** `summarize()` runs one `ctx.llm.stream()`. Ten small passes cost
  ten calls. This is the main reason "breathing" is expensive at the compaction layer; a
  model-free prune path (rewriting old tool receipts) would be cheaper but is a different engine
  and cannot summarize conversation.
- **Cache:** each replacement invalidates the prefix from the first changed token. Batch small
  passes at turn boundaries; keep the system prefix untouched.
- **Safety:** replacing a compaction backend can corrupt a session's surface. Test in a scratch
  profile with a disposable conversation; keep the default engine one patch line away.

## Config-only quick win

Before writing any engine code, the shipped backend can already approximate the Coopanion band:

```yaml
- id: <existing compaction-basic loader id>
  config:
    thresholdRatio: 0.92
    retainRatio: 0.5
    headroomTokens: 65536
```

This keeps a 50% recent verbatim tail and compacts at 92%. It is still a threshold + one summary,
not breathing, but it is a real, reversible test of the band on DSH — and it changes no code.

Find the id in Creator mode: `cordis_inspect_list` for the `Config` provider, locate the
`@deepseek-ai/dsh-compaction-basic` entry, and read its loader id / tree id. An unknown id in a
patch is not guaranteed to be a harmless no-op.

> **Measured caveat (2026-10-26):** on this desktop profile the base row is disabled and the live
> engine is preset-scoped (`preset-standard` → group `compaction` → `compaction-basic`), which no
> patch id can address. The experiment is therefore shipped as a **copy of the preset declaration**
> with the changed child config (`docs/EXPERIMENT.md`), not as a row override. The base row id is
> still recorded above for profiles where compaction-basic is host-level.

## Version pinning

The DSH app ships `@deepseek-ai/dsh-compaction` / `-basic` `0.2.x` (runtime `0.2.1-rc.3` in the
packages inspected). Before publishing, pin `peerDependencies` to the range the app actually
provides and run `dsh plugin ... add` against a scratch profile.

---

# Measured at runtime — 2026-10-26

Everything below was read from the **running** desktop Host and its installed packages, not from
npm types. Environment: `@deepseek-ai/dsh-desktop` `0.2.1-rc.3`, bundled runtime
`@deepseek-ai/dsh-desktop-runtime` `0.2.1-rc.3` under `resources/app.asar/dsh`, profile `desktop`,
Electron `process.resourcesPath` present.

## 1. Compaction loader rows

`cordis_inspect_query` → Host `Config`, `listConfigs`:

| What | Exact value |
|---|---|
| Base row id | `include:compaction-basic` |
| Base row `patchId` | `compaction-basic` |
| Base row name | `@deepseek-ai/dsh-compaction-basic` |
| Base row enabled in this profile | **false** (`fiberPhase: null`) |
| Base row `packageDir` | `…/app.asar/dsh/node_modules/@deepseek-ai/dsh-compaction-basic` |
| Preset row id | `include:preset-standard` |
| Preset row `patchId` | `preset-standard` |
| Preset row name | `@deepseek-ai/dsh-agent-preset` |
| Preset row `packageDir` | `…/app.asar/dsh/node_modules/@deepseek-ai/dsh-agent-preset` |

The **effective** engine is not the base row. It is a child of the `standard` preset:

```
preset-standard
└─ group: compaction          isolate: { compaction: true, toolResultPruner: true }
   ├─ compaction-basic
   ├─ command-compact
   └─ tool-result-pruner
```

Consequences, confirmed live:

- The preset child is **not addressable** by a loader patch id. `Config.listConfigs` rejects
  `include:preset-standard:compaction:compaction-basic` (nested entry ids use `:`), and a patch
  with an id plus `config` targets only top-level rows.
- Therefore the config-only experiment cannot override "the existing row"; it must **copy the
  preset declaration** with the changed child config. This plugin ships that as the `band` preset
  and leaves `preset-standard` untouched. See `docs/EXPERIMENT.md`.
- The preset declaration `Config` schema is `{ id, name?, description?, order?, plugins }`.
- After installing this plugin, the Host roster contains `include:preset-band` and
  `include:preset-continuity` in addition to the four shipped presets.

## 2. `ctx.tokenMeter` (exact)

```ts
measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement
estimateMessage(message: Message): number
```

`TokenMeasurement` is detached and deeply immutable:

```ts
interface TokenMeasurement {
  readonly logRevision: SessionLogOffset
  readonly baseline:
    | { readonly kind: 'none'; readonly tokens: 0 }
    | { readonly kind: 'estimated'; readonly tokens: number }
    | { readonly kind: 'usage'; readonly tokens: number; readonly usage: Readonly<TokenUsage> }
  readonly surfaceDeltaTokens: number
  readonly totalTokens: number       // the pressure number the policy uses
  readonly surfaceTokens: number
  readonly nodes: readonly TokenSurfaceNode[]
}
interface TokenSurfaceNode {
  readonly seq: SessionSeq           // same positional seqs as session.surface.nodes
  readonly tokens: number            // route-priced (images included)
  readonly heuristicTokens: number   // fixed estimator, used for shadowedTokenCount
}
```

The `nodes` array is positionally aligned with `session.surface.nodes`; `BasicCompactionEngine`
rejects a measurement whose surface does not match exactly. `measure()` clones the positional
nodes, so holding one across a surface change is safe but stale.

## 3. Session surface (exact)

```ts
session.surface: {
  readonly nodes: readonly SessionSeq[]   // surface positions, oldest first
  readonly replaceGeneration: number      // bumps on a replace transaction
  readonly contentGeneration: number
}
session.id: SessionId
session.seq: SessionLogOffset
session.eventAt(seq: SessionSeq): SessionEvent | undefined
session.deriveEventMessage(event: SessionEvent): Message | null
session.requestHeader(): EpochHeader | undefined
```

`EpochHeader` is `{ config: { provider, model, maxTokens?, … }, tools?: ToolSchema[], adapterDefaults? }`.
Real header observed in a compacted session:

```json
{ "provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "max", "maxTokens": 256000 }
```

That `maxTokens` is the **conversation request's** reserved output, and it is what
`BasicCompactionEngine` subtracts from the context window. It is not the summary cap.

## 4. Window capacity and the config-only arithmetic

```ts
ctx.llm.resolveModelInfo(provider, model, signal?): Promise<{
  context?: { contextWindow: number }
  defaultMaxTokens?: number
  …
}>
```

Measured for `deepseek-official/deepseek-flash`: `contextWindow = 1_048_576`,
`defaultMaxTokens = 256_000`. The base backend computes (`resolveCompactSpec`):

```
messageBudget = contextWindow − reservedCompletionTokens
threshold     = floor(min(contextWindow × thresholdRatio, messageBudget − headroomTokens))
retain        = floor(messageBudget × retainRatio)
require retain < threshold
```

Defaults: `thresholdRatio 0.8`, `retainRatio 0.16`, `headroomTokens 65_536`,
`maxTokens = headroomTokens` (the summary output cap), `compactionRetries 1`,
`maxOverflowRetries 1`.

For this model (`messageBudget = 792_576`):

| Config | Threshold | Verbatim retain | One pass at threshold |
|---|---|---|---|
| shipped `0.8 / 0.16` | 727,040 | 126,812 | 600,228 |
| experiment `0.92 / 0.5` | **727,040** | **396,288** | **330,752** |
| band engine, cache-first `86% / 62% / protect 30%` | triggers at **681,615** | protects **237,773** | one ~190,000 drain to low |

Note the cap: `0.92 × W` is 964,690, but `W − O − headroom` is 727,040, so the 92% experiment is
limited by headroom, not by its ratio. The config is valid (`396,288 < 727,040`).

Version note: the older `0.1.5` runtime's `resolveCompactSpec` used
`threshold = floor(W × ratio)` and `retain = floor(W × retainRatio)` with **no** output reserve or
headroom, and defaulted `maxTokens` to **8192**. The current `0.2.1` Host subtracts the reserve and
headroom as shown above and defaults `maxTokens` to the headroom (65,536). Older compaction records
with `maxTokens: 8192` (for example `session-4185b80f…`) come from that generation; the current-era
records carry 65,536. The projection in the panel is the 0.2.1 formula.

## 5. Summary result and the provenance field

```ts
summarize(input: SummarizationInput, agent: Agent, signal?): Promise<SummaryResult>
type SummaryResult = {
  summary: ContentBlock[]        // ← confirmed; blocks, not a string
  provider: string
  model: string
  maxTokens?: number
  usage?: TokenUsage
} & ({ rawOutput: ContentBlock[]; llmStreamCall: true }
   | { rawOutput?: ContentBlock[]; llmStreamCall?: never })
```

`frameSummary()` wraps the returned blocks in the fixed checkpoint preamble plus
`<compacted-summary>…</compacted-summary>`. Our `annotateSummary(base.summary, header)` therefore
prepends the `[gist …]` line to the first text block, inside the summary tags and after the
preamble. Verified format from a real transaction:

```
block 0: "This is an automatically generated checkpoint …"        (preamble)
block 1: "## Primary Request and Intent …"                          (summary; our header lands here)
block 2: "</compacted-summary>"
```

## 6. Real compaction transaction record

Decoded from the local `session.v4.jsonl.zstd` logs (read-only scan; the logs are concatenated
zstd frames, so one-shot `zstdDecompressSync` only yields the first frame — split at the
`28 B5 2F FD` magic bytes and decode each frame, or use the persistence package's frame scanner):

```
session   session-2f831fa2-a345-4e99-bce7-5796444fea57
compactionId  b57ba840-1892-4175-b652-06c7e30b8609
start     seq 8255
summary   seq 8257   shadowedRange 4424–7043
                     1259 surface nodes, 363,912 tokens
                     summary model deepseek-flash, maxTokens 65536
                     usage 505,602 input / 4,731 output
replace   seq 8258   surfaceOp { replace, startSeq 4424, endSeq 7043 }
                     source { kind: 'compact-checkpoint', compactionId: b57ba840… }
end       seq 8259
```

Other observed one-pass cliffs in the same log set: **354,500**, **342,756**, **425,772**,
**442,443** shadowed tokens. Those are the behavior the band controller exists to replace.
The summary text in all seven observed transactions starts directly with `## Primary Request`
— there is no gist header in the shipped backend, which is why `summarize()` is overridden.

## 7. Tool pairing and the transaction seam

Confirmed exports of `@deepseek-ai/dsh-compaction` (runtime `lib/index.js`, and exercised by the
engine's import):

```ts
toolPairingBalancedBefore(session, seq): boolean   // cut immediately BEFORE seq
toolPairingBalancedAfter(session, seq): boolean    // cut immediately AFTER seq
compactCheckpointSource(compactionId, sourceCommandId?): { kind: 'compact-checkpoint', … }
isCompactCheckpointSource(source): boolean
```

The predicates throw when the seq is no longer on the current surface. `compactRegion(start, end,
agent, signal?)` validates both edges, the span, the active-turn lock, and then runs the transaction.
`CompactionResult` carries `compactionId, startSeq, summarySeq, endSeq, summary, shadowedRange,
shadowedSeqs, shadowedTokenCount`.

## 8. System prompt section

```ts
ctx.systemPrompt.section(section: PromptSection): () => void
interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string | ((context) => string)
  readonly interpolate?: boolean
  readonly complete?: boolean
}
```

Section order is a plain number; the repository's named orders run from `HARNESS_IDENTITY (−1000)`
to `DEPLOYMENT_PERSONA_SUFFIX (10200)`. The standing provenance convention is mounted once at
**order 9500**, after the tool sections and before structured output, via
`ctx.inject(['systemPrompt'], …)` so the engine still loads in a profile without that service.
Live state reports `standingConvention: 'registered'`.

## 9. How this plugin loads the base class

The plugin is installed as a **`link:`** dependency (`pnpm` warns that peer dependencies do not
resolve from the linked target). A plain `import '@deepseek-ai/dsh-compaction-basic'` from the
workspace would therefore fail, or find a different runtime generation. The engine instead tries,
in order:

1. `file://<resources>/app.asar/dsh/node_modules/@deepseek-ai/<pkg>/lib/index.js`
2. `file://<resources>/app.asar/node_modules/@deepseek-ai/<pkg>/lib/index.js`
3. `@deepseek-ai/<pkg>` (portable fallback)

The live panel snapshot confirms candidate 1 was used for both `dsh-compaction-basic` and
`dsh-compaction`; the engine extends the same `BasicCompactionEngine` / Cordis `Service` generation
as the Host. If Electron cannot import from `app.asar`, the fallback keeps the engine loadable but
would mix generations — the panel surfaces the chosen package URL under `engine.base`.

## 10. Remaining unknowns / limits

- **Manual `/compact` has no gist header yet.** `compactNow` selects its range inside the inherited
  transaction, so this version cannot label it before `summarize()` runs. Automatic band passes are
  labeled; manual compaction keeps the plain checkpoint preamble.
- **The cache-first policy was observed live on 2026-10-26 at 18:33:16.** One `band-high` pass:
  `estTokens 745,243`, `tokens 179,725`, `count 143`; the next requests returned to ~99.96% cache
  hits. The same session's old policy had produced 53 passes (698,108 tokens, 34 one-node passes).
  See `docs/CACHE.md`.
- **Panel pixels are unverified.** There is no browser control in this environment. The client
  module, locale registration, both slot registrations, and the full element tree were exercised
  headlessly (`tools/smoke-client.mjs`), but light/dark appearance and layout are not claimed.
- The **summary cap** `maxTokens` is inherited from `headroomTokens` (65,536) when not configured;
  `compaction/summary` records show 65,536 or 8,192 depending on the session's config generation.

## 11. Cold-start route bug (fixed 2026-10-26)

**Symptom after a DSH restart:** `include:dsh-continuity` is `enabled: true, fiberPhase: active`,
`include:preset-continuity` is active, but `GET /dsh-continuity/state.json` returns **404**. A
running install worked; only a fresh boot lost the panel.

**Cause:** `apply()` read `ctx.get('webServer')` synchronously and returned early when the service
was not yet published. On a cold start the row can activate before the Web-server row, so the row
stayed active with no route. The previous session had installed the plugin into an already-running
Host, which hid the ordering bug.

**Fix:** the route is registered through `ctx.inject(['webServer'], (scoped) => { … })`, so it
appears when the service is ready and is disposed with the plugin. Do not read an optional service
synchronously in `apply()` unless the row declares it in `inject`; use `ctx.inject` for optional
services.

**Verification after the fix:** the state route must return 200 and `engine` must be non-null on a
fresh boot, not only after a hot install.

## 12. Cache-first policy (2026-10-26)

The policy source of truth is `CACHE_FIRST_POLICY` in `src/policy.mjs`. `preset-continuity` pins
only `policy.setpoint: 0.86` (the cache-first value) so a hot preset reconciliation cannot fall
back to the older 0.72 module default; every other field inherits. It previously restated the whole
policy with the old `0.65/0.80/0.55/8k/4k` values and silently overrode the new code defaults —
that mismatch was the reason the 18:07 edit appeared not to work. The full analysis and
measurements are in `docs/CACHE.md`. Key facts:

- 53 compactions in `session-0b094f6e…` removed 698,108 tokens; 34 were one-node passes.
- One request read `cacheRead 733,184`; the request after a 4k compaction read
  `input 733,414 / cacheRead 8,704` — one pass invalidated a 733k-token prefix.
- `CACHE_FIRST_POLICY` sets `setpoint = high = 0.86`, `low = 0.62`, `maxPerBatch = 190_000`,
  `minAction = 24_000`, `protect = 0.30`, `emergency = 0.96 → 0.80` (0.2.1; was 0.88). At
  `W = 792,576` that is a 681,615 trigger, a 491,397 drain, and a 237,773 protected tail;
  698,108 / 190,000 ≈ 4 passes.
- `setpoint = high` removes the proportional-zone passes. `CACHE_GRADUAL_POLICY` (setpoint 0.72)
  is the smoother, lower-cache variant.
- The preset pins `policy.setpoint: 0.86` and (0.2.1) `policy.emergencyTo: 0.80`. A plugin-manager
  remount at 18:27:37 applied the setpoint pin live; the emergencyTo pin is what lets a remount
  pick up the 0.2.1 fix without reloading the cached `policy.mjs`.
- Node's ESM module cache persists across a preset reconciliation: a hot remount re-reads the
  preset config but **not** the edited `policy.mjs`. The explicit pin is what made cache-first
  live without a process restart. A full restart is still required to load the `ctx.inject`
  cold-start fix and any code-only default.
- Existing sessions keep their mounted revision; a restart, a bundle remount, or a fork mounts the
  current policy.

## 13. `session_log` retrieval tool (0.2.0)

**Host read API.** The tool uses the exact-read face of `ctx.sessionQuery` (the base
`session-query-sqlite` row keeps exact reads even with `openAt: never`):

```ts
ctx.sessionQuery.readSession(sessionId): Promise<{
  session: SessionHeader
  inheritedEventCount: SessionLogOffset
  events: SessionEvent[]           // complete raw log, replay-validated
}>
```

`readSession` is live-preferred: a live session is read from memory, a persisted one from JSONL.
It makes the session live? No — the docs say “without making it live”; it returns a cloned
snapshot. There is also `readEvent({sessionId, seq, before, after})` for a window, but the tool
reads one snapshot and formats locally so index/get/grep share one view.

**Registration.** `src/session-log-tool.mjs` exports `inject = ['tools', 'sessionQuery']` and
`apply`, which builds a plain `ToolDefinition` and calls `ctx.tools.register(tool)` in the
**calling (preset) scope**. The `preset-continuity` plugin list carries:

```yaml
- id: session-log-tool
  name: dsh-continuity/session-log-tool
```

`preset-band` and `preset-standard` do **not** carry the row, so their agents see no `session_log`
and the tool registry reports it absent for those scopes. The tool needs no
`@deepseek-ai/dsh-tools` import (`defineTool` is a validation wrapper; a plain JSON-Schema
`ToolDefinition` is accepted), which keeps the `link:` install from needing a workspace peer.

**Seq contract.** `seq` is the session event seq, the same number in
`[gist · log:<session>#seq=A-B]`. `A-B` is a *surface* range and can be non-monotonic (for example
`3005-1872` after a replacement). `get` first looks for a `compaction/summary` whose
`shadowedRange` equals the requested range and then reads exactly its `shadowedSeqs` in surface
order; only an unmatched, ordered range falls back to a numeric filter. This is what lets the
0.1.0-era gists remain retrievable without rewriting their headers.

**Read-only / budget.** The tool calls only `readSession`; it never appends, replaces, projects, or
compacts. Output is bounded: `index` 12k chars, `get` 16k with `MAX_EVENT_CHARS 2400`, `grep` 12k;
`limit` default 20 (max 100), `context` max 10. A truncated result carries a manifest, the role
histogram, and a next seq or a “narrow with grep” instruction. `grep` excludes `system/message` so
the convention/tool descriptions cannot match; `get <seq>` can still read a system event.

**Scope verification.** `state.json` now carries `tools.sessionLog` (registration) and
`tools.scopes` (per live agent: current preset, `sessionLog`, `convention`, tool count). The probe
reads the **`agentPreset` projection**, not `session.header.agentPreset`: the header is the
creation fact, and `session-0b094f6e…` was created as `standard` then switched to `continuity`.
Using the header alone mislabels that session and skips the convention check. The projection is
authoritative.

**Live 0.2.0 state (before the required restart):** the host row re-imported as `0.2.0` and the
scope probe shows the long session as `preset: continuity`, `convention: true`, `sessionLog: false`
with 32 tools; the `session-log-tool` row is part of the preset declaration read at boot, so the
running process still has the old preset. A restart is required to mount it; after the restart the
same probe should read `sessionLog: true` and the tool count should increase by one. The retrieval
logic itself is exercised against the real log by `tools/acceptance-0.2.0.mjs`.

The exact-read Host API is already verified live: `state.json.sessionQuery` reports
`{ source: "ctx.sessionQuery.readSession", sessionId: "session-0b094f6e…", events: 3292,
firstSeq: 0, lastSeq: 3291 }`. That is the same `readSession` call the tool's `execute` makes;
only the preset row registration is waiting for the restart.

**Policy override answer.** The handoff's premise that `DEFAULT_POLICY.setpoint` is 0.72 is stale:
the source now exports `CACHE_FIRST_POLICY` as `DEFAULT_POLICY` with 0.86, and
`CACHE_GRADUAL_POLICY` is the 0.72 variant. The runtime 0.86 comes from both the source default and
the explicit `policy.setpoint: 0.86` pin in `cordis.patch.yml`. The pin is intentional (it made the
cache-first policy live across a hot remount and protects against a stale module default), not a
leftover. The two options for 0.2.0 are: keep 0.86 (one 190k pass per high crossing, fewer cache
invalidations, higher average context) or switch to 0.72 (24k proportional passes, smoother
context, more invalidations). The package ships 0.86; the switch is one config/policy line.

## 14. 0.2.0 acceptance record (real session log)

`tools/acceptance-0.2.0.mjs` decodes `session-0b094f6e…` (3,293 events, 54 gists) and runs the
same pure functions and ToolDefinition the model uses:

- `index` lists the newest gist `seq=3020 · surface 3005-1872 · 143 msgs · ~179,725 tok`.
- `get` with the pointer `[gist · log:… #seq=3005-1872 …]` resolves via
  `compactionId b07faeb0-ca36-45c8-88f9-9bfcf1dca9b2` to exactly 143 events, returns a manifest
  (`user:14 assistant:53 tool:76`) and truncates at 5 (`next seq=1222`).
- `get seq=1604 context=1` returns the raw user message containing
  “鲸鳍不是尖刀/叶形——它是宽的扇面…”.
- `grep "鲸鳍不是尖刀"` returns seq 1604 (raw) plus the newer gist copies at seq 3020/3021; `get`
  the match ±1 returns the original.
- `get seq=999999` fails with
  `seq 999999 is not in this session (valid event seqs 0-3291). If the original is unavailable, say
  you only remember the gist.`
- Frozen-event read-only test and `parsePointer` for plain ids, pointers, and full gist headers
  pass in `test/session-log.test.mjs` (15 tests).

## 15. `emergencyTo` double-pass fix (0.2.1)

`emergencyTo` was 0.88, **above** `high = 0.86`. At 97% the emergency pass landed at 88% (697,467),
still above high, and the next batch immediately ran a second band-high pass to 62% — two prefix
invalidations and two summarization calls for one overshoot. 96% exactly was *better* because it
went straight to band-high.

0.2.1 sets `emergencyTo = 0.80` (and pins it in `preset-continuity`, like `setpoint`):

| At | One pass | After | Headroom to high 681,615 |
|---|---:|---:|---:|
| 97% (768,799) | emergency, budget 134,738 | 634,061 (80%) | 47,554 (6% W) |
| 96.1% (761,666) | emergency, budget 127,605 | 634,061 (80%) | 47,554 |
| 96% exactly (760,873) | band-high, budget 190,000 | 570,873 | 110,742 |
| 0.88 (old) at 97% | emergency 72,000, then band-high 190,000 | 570,873 after two passes | two invalidations |

Why 0.80: one emergency lands below high with a 6% window before band-high can fire again; it is
shallower than the old 0.88-plus-band-high chain and shallower than a band-high at 97% would be
(190k to 570,873). 0.85 leaves only 1% W (7,926 tokens) and re-triggers almost immediately; 0.62
would be one pass but a 277k cut. `high`, `low`, `protect`, `maxPerBatch`, `minAction`, `setpoint`,
`standard`, and Coo were not changed.

Tests: `test/policy.test.mjs` now has 14 cases, including exact-96% band-high and a just-over-96%
emergency that must leave `after ≤ high − 0.05W`; the suite is 46 tests total. The policy pin also
makes the value visible in `state.json` after a remount even while the cached module still carries
0.88. Live check on the 5276 Host after the 0.2.1 pin remount: `engine.policy.emergencyTo = 0.80`,
`tools.sessionLog.name = session_log`, continuity `sessionLog: true` / `convention: true` /
`toolCount: 33`, `sessionQuery.events = 4776`; `plugin.version` is still `0.2.0` because the host
row's package.json require is cached, so a full restart is needed to display `0.2.1`. The 0.2.1 tgz
carries the new version, code, pin, and docs.

## 16. 0.2.3 — surface stats, A4-safe, summary view

### Stats口径

`session_log stats` now defaults to `scope=surface`, reads `session.surface.nodes` on the live
session, and uses `tokenMeter.measure(session)` for route-priced tokens:

- `surfaceTokens` is the model-visible message surface; `baseline` (system/tool schema/request
  overhead) is reported separately; `totalTokens = surfaceTokens + baseline`.
- Categories: `reasoning`, `tool_result`, `assistant_text`, `tool_call`, `user`, `system`,
  `developer`, `gist` (raw only).
- `tool_result` is `tool/result` content; `tool_call` is assistant tool-call arguments; the
  `tool/call` marker is not double-counted. Within an assistant event, the event's route-priced
  token count is split across reasoning/text/tool-call by chars, so those three token rows are a
  split of an exact event total.
- `tools_schema` is a separate baseline row (33 tools / 31,115 chars / ~7,779 tokens in the
  2026-10-26 session).
- `tail` walks `tokenMeter` nodes from the end to `protect × W`; `protect 0.30` is a fraction
  (237,773 tokens at W=792,576), not 30 tokens. `scope=raw` remains available and is labelled
  `chars4 estimate`; it includes historical/shadowed content and must not be read as the context.

Measured on `session-0b094f6e…` before the A4 change:

- current surface (584 nodes, 1,251,664 text chars): assistant 86.8%, tool result 8.8%, user 3.9%,
  system 0.5% by chars; block proxy reasoning ~78%.
- the last cache-first pass (183,383 tokens, 728,081 chars): reasoning 80.0%, tool result 11.0%,
  tool-call 4.4%, user 2.7%, assistant text 1.9%; 46% of the reasoning was in assistant messages
  that also carried a tool call.
- 10 v4 sessions: tool result 8.8–81.6% of surface chars, aggregate 31.0%; assistant 66.0%, user
  1.8%. The Continuity session is reasoning-heavy; coding sessions are tool-heavy.

### A4-safe

- Active call ids: every `tool/call` in the current open turn plus every call with no matching
  `tool/result`; pins are the assistant tool-call surface messages and their tool results.
- `applyToolPreviews` walks non-active `tool/result` nodes oldest-first, builds a 1,280-char
  head/marker/tail preview, and estimates `estimateMessage(original) - estimateMessage(preview)`.
  The target is **`low` (62%)** for `band-high` and **`emergencyTo` (80%)** for `emergency`, not
  `high`: it applies the chosen previews even when they cannot cover the whole gap, and the
  remaining pass then continues to that target even if the estimate is already below `high`.
  Stopping at `high` was the 0.2.2 bug: it left the context hovering at 86% and invalidated the
  prefix on every subsequent batch. The full compression now produces one 24%-W band per high
  crossing.
- If the preview already reaches the target, no pass runs. If it cannot, the pass folds the oldest
  user/reasoning only then; active pins stay full. `band-high` keeps the 190k pass cap, `emergency`
  keeps its normal uncapped drain; the preview itself is not a pass and is not capped by
  `maxPerBatch`.
- Applied previews append a `compaction/prune` shadow-price event and a replacement `tool/result`
  with `surfaceOp: replace`; the raw event remains in the log and the marker cites
  `session_log get seq=<n>`. User/assistant/reasoning text is untouched. Only text-only tool
  results are previewed; mixed image/file results are skipped.
- Active pins count toward the `oldestRange` tail floor, so the pass stops before the oldest active
  pin; if no range fits with an active pin, pressure compaction is skipped rather than folding it.
- `protect 0.30`, `high 0.86`, `low 0.62`, `maxPerBatch 190000`, `minAction 24000`, `setpoint 0.86`
  are unchanged; A4 is a pre-pass preview, not a policy change.

### B — summary view

`summarize()` copies `SummarizationInput.messages` and previews only `role: 'tool'` long text with
the same 1,280-char cap; human/assistant/reasoning messages stay verbatim. The preview marker cites
the gist header so the summary model can `session_log get` the range. This changes the summary
call's input, not the surface, tail, cache, or pass count. A4 and B overlap on the same tool
results: after A4 has previewed the pass range, B sees the already-short preview and adds little;
B remains the fallback when A4 is skipped and a quality layer for the gist.

### Tests / version

`test/tool-preview.test.mjs` covers active call/pin detection, preview head/tail/marker,
non-text and short skips, frozen replacement, summary-view copy, and the low/emergency target
budget. `test/stats.test.mjs` covers block classification, token splitting, tail walking,
live-surface vs raw, and the tail output. 0.2.3 is 61 tests total (policy 14, provenance 8, range 9,
session-log 15, tool-preview 9, stats 6). The `session_log` tool injects `tokenMeter`; `state.json`
now also carries `context` and `previews` for verification.

## 17. 0.2.4 — 3-turn active window, non-text handles, overflow pause

### B: active window

`activeCallIds(events, { recentTurns: 3 })`: every call in the current open turn, plus every
unpaired call whose `turn` is in the last 3 turn numbers. Older unmatched calls are treated as
abandoned project debris and do not pin the tail. This replaces the 0.2.3 global unmatched set,
which could pin a very old interrupted call forever. Tests cover the 3-turn boundary.

### D: non-text handles

At every `compactIfNeeded` entry (pressure and overflow), `handleNonTextResults()` walks the
surface, finds `tool/result` nodes with image/file/audio/video blocks, and replaces the whole
message with a text handle:

```text
[tool result handle · seq=N · tool=... · call=... · types=image/png · name=... · bytes=...
 path=...]
topic / function / importance / caveats / summary
original archived at seq=N; ...
```

The payload remains in the raw log; it is not in the model context. `nonTextInfo()` is
deterministic. The semantic fields are produced by one auxiliary `summarize()` call with the
non-text content in a user message and a structured prompt; unsupported content or an auxiliary
failure falls back to metadata, with `importance: unknown` (or `high (error)`) rather than a
fabricated judgment. The handle keeps the same call id, so an active non-text result remains
active/pinned; a non-active handle may be folded later, with its summary preserved in the gist.
`session_log get` cannot re-inject binary; the handle carries the attachment path when present.

### A: active-overflow pause

`context-overflow` is the only provider-confirmed path that may touch an active result. After D,
`handleOverflow()` finds the largest active tool result. If its estimated tokens are at least the
measured overage, it replaces it with a `[continuity pause]` text handle (same call id, still
active). The handle tells the instance to stop retrying/compressing, tell the user the context
window is too small, and ask for a larger one; the raw original is at `seq=N`. The base
`agent/request-error` listener sees the surface progress and retries once; if the result was not
the cause, the base overflow fallback runs. Normal pressure/band paths never detach an active
result.

### C: raw overlap

`stats scope=raw` includes both a `compaction/summary` event and its replacement user message; the
raw gist/user shares can be inflated by roughly 10 points. This is archive-only and does not enter
model context; surface stats remain authoritative. The raw output now says
`historical; may overlap summaries; not context`.

Tests: 0.2.4 is 65 tests total (policy 14, provenance 8, range 9, session-log 15, tool-preview 13,
stats 6). `test/tool-preview.test.mjs` now covers the 3-turn boundary, non-text handle/pause text,
original immutability, and call metadata. The `state.json` FACTS retrieval row includes `stats`.

## 18. 0.2.5 — handle re-preview fix, post-pass measurement, manual labels

### A4 must not preview a handle/pause/preview

`isNonPreviewableBlocks(blocks)` rejects text containing `[tool result handle`,
`[continuity pause`, or `[... tool result preview`. `previewToolResultEvent` and
`previewSummaryInput` both return null/unchanged for those messages. Before 0.2.5, a D semantic
handle (~1,700 chars) could be truncated by A4; the summary/importance/path were cut and the A4
marker pointed at the handle's replacement seq instead of the original non-text event. Handles and
pauses are now terminal representations.

### Post-pass measurement

After `compactRegion()` succeeds, the engine calls `measure()` again and writes `afterTokens`,
`afterSurfaceTokens`, `afterBaselineTokens`, and `rebloatTokens` into the pass record. The panel's
"after" is now a real measurement; `state.context` updates immediately. A real post-pass re-bloat is
visible without waiting for the next pressure trigger. `measure()` failure is recorded as a warning;
the pass record still exists.

### Manual `/compact` labeling

`compactNow()` still delegates to the base manual cut (it can be much deeper than the 62% band), but
after it settles 0.2.5:

1. appends a `[gist · log:…#seq=A-B · N messages · original retrievable via session_log]` header as
   a plugin `user/message` after the summary;
2. measures the post-pass surface;
3. records a `recordPass` with `reason: 'manual'`, `budget: 0`, the header, and the after/re-bloat
   fields.

The base summary itself is unchanged and still unlabeled; the follow-up header is the pointer. This
makes a manual cut visible in `passes` and retrievable by the model.

Tests: 0.2.5 is 66 tests total (policy 14, provenance 8, range 9, session-log 15, tool-preview 14,
stats 6). `test/tool-preview.test.mjs` adds the handle/pause/preview non-repreview case. The engine
integration (post-pass/manual header) is checked with `node --check` and the live/state path rather
than a base-engine unit test.

## 19. 0.2.6 — 515k hard-cap policy

`CACHE_FIRST_POLICY` changes from the cache-first 86/62/96→80 band to the 515k hard-cap band:

```text
setpoint    0.62  → 491,397  (46.9% full)
high        0.62  → 491,397
low         0.42  → 332,882  (31.7% full)
emergency   0.65  → 515,174  (49.1% full)
emergencyTo 0.45  → 356,659  (34.0% full)
protect     0.30  → 237,773
maxPerBatch 190000
minAction   24000
```

The full context is 1,048,576; 515,174 is **49.1% full / 65% of W**. The emergency trigger is the
515k cap, not the old 96% near-overflow line. `planFold` uses strict `>` for emergency: exactly
0.65 still takes one band-high pass to low; only above 0.65 is the emergency path. `emergencyTo`
0.45 is below high 0.62, so one emergency cannot chain into band-high.

`CACHE_GRADUAL_POLICY` keeps the same water marks with `setpoint: 0.50` for a 50–62% proportional
zone (the old 0.72 setpoint is invalid above high 0.62).

Tests remain 66; `test/policy.test.mjs` now asserts the 61/62 no-op boundary, the 0.64 band-high
drain, the 0.65 still-band-high boundary, the 0.45 emergency target, and the 0.50 gradual setpoint.
The preset pins are `setpoint: 0.62` and `emergencyTo: 0.45` in `cordis.patch.yml`; the other
fields inherit from `src/policy.mjs`.

## 20. 0.2.7 — 92% high/emergency ratio

0.2.7 keeps the 515k emergency cap and moves high/low down:

```text
setpoint    0.60  → 475,546  (45.4% full)
high        0.60  → 475,546
low         0.40  → 317,030  (30.2% full)
emergency   0.65  → 515,174  (49.1% full)
emergencyTo 0.42  → 332,882  (31.8% full)
protect     0.30  → 237,773
maxPerBatch 190000
minAction   24000
```

`high / emergency = 0.60 / 0.65 = 92.3%`, leaving **39,628 tokens (5% W)** between the normal
trigger and the hard cap. The previous 0.62/0.65 ratio left only 23,777 (3% W), below
`minAction 24k`; 0.2.7 crosses that structural boundary. The band is still 158,515 (20% W), and the
emergency band is 182,292, within `maxPerBatch`.

The exact boundary is unchanged: at exactly 0.65 the pass is still band-high and is capped at
190,000, so it may take two passes to reach 0.40; above 0.65 the emergency pass ignores the cap and
lands at 0.42.

`CACHE_GRADUAL_POLICY` remains `setpoint: 0.50`; its proportional zone is now 50–60% (valid below
high 0.60). The preset pins are `setpoint: 0.60` and `emergencyTo: 0.42`.

Tests: 66 total. Policy tests assert the 59/60 no-op boundary, the 0.62 band-high drain, the
0.65 band-high cap, the 0.42 emergency target, and the 0.50 gradual setpoint.

## 21. 0.3.0 — explicit work threads

### State

`~/.dsh/continuity/threads.json`, partitioned by session:

```json
{
  "version": 1,
  "sessions": {
    "<session>": {
      "activeId": "t-…",
      "threads": [{
        "id": "t-…", "label": "…", "why": "…", "next": "…",
        "seqStart": 1, "seqEnd": 2, "seqs": [1, 2], "count": 2,
        "spanStart": "…", "spanEnd": "…", "minutes": 1, "tokens": 2,
        "residue": "…", "archiveRef": "log:<id>#seq=1-2",
        "gistSeq": 3, "compactionId": "…", "active": false,
        "loadSeq": 4, "injected": 2, "loadTokens": 2
      }],
      "pending": { "kind": "save" }
    }
  }
}
```

Writes are atomic (`threads.json.<pid>.<time>.tmp` → rename) and serialized. The rules file
`~/.dsh/continuity/rules.md` is read-only; it is never created, written, or defaulted. A missing
file means no rules.

### Tool

A single `continuity` tool with actions `save`, `load`, `active`, `list` (provider function names
cannot contain dots; these are the contract's `continuity.save/load/active/list`). `save` requires
`label`, `why`, and `next`; `load` requires `id`; `budgetTokens` defaults to 8,000 and is capped at
20,000.

### Save: validate, defer, commit

`prepareSave()` runs in the tool call and writes a `pending` record; it does not append. It:

1. accepts only surface seqs, never the system head, never a gist/thread node, never a node at or
   after the current `turn/start`;
2. requires both endpoints to be `toolPairingBalancedBefore/After`; a cut is rejected with the seq;
3. defaults to after the latest gist and before the current open turn, walking inward to balanced
   edges (`adjusted: true` when it had to move);
4. prices the range, computes the real-clock span/minutes, and creates the thread id/archiveRef.

At the next pre-step, after the tool result, `saveThread()` calls the inherited `compactRegion()`
with a one-shot thread summary. The base transaction appends `compaction/start`, the summary, the
replacement `user/message` with `surfaceOp` and `sourceEventSeqs`, and `compaction/end`. The engine
then appends a `compaction/prune` price marker, records the thread, clears `activeId`, and clears
`pending`. This is the same host validation as an automatic gist: the raw range is never rewritten,
and the fold is append-only.

The gist body starts with `[thread] … 下一步:…` and carries a second `[gist · log:…]` line so
`session_log index` still recognizes it.

### Load: quote the newest raw segment

The tool reads `sessionQuery.readSession`, resolves the thread's exact `seqs` (surface order, not a
numeric range), and selects newest-to-oldest until `budgetTokens`; the last event is always included,
so the count is a lower bound. It writes a pending load and sets `activeId`, without appending. At
the next pre-step the engine appends one normal `user/message`:

```
[放] <label> · 现在算在「<id>」这条线上 · 下一步:<next> · 上次收:<why> · 存档:<ref>
—— 以下是从原文取回的最后一段 ——
[<role>] <raw text>
```

No original node ids are copied. Missing raw, or a missing seq, produces the index-only line and
`{ ok:false, reason:"raw-missing", active:true, pending:true }`; it does not invent text.

### Per-turn injection and pins

At the first pre-step of each turn (`agent.lastTurn`, else the latest `turn/start` seq), the engine
appends one `user/message` with:

```
[线] 当前：<label>（已载入）· 下一步：<next>
     已收起 N 条：<labels>
<rules.md verbatim, ≤400 estimated tokens>
```

This is after the surface tail, never in the system/tool prefix; it is a user message because the DSH
surface has no developer role. Rules are re-read every turn; >400 tokens is truncated with a warning.
The line is capped at 200 estimated tokens. The same turn is injected once; the next turn re-reads.

After a load, `loadSeq` joins the active tool pins. `oldestRange()` counts from the oldest pin to the
end as the tail floor, so automatic compaction stops before the loaded quote. A save clears
`activeId`, making the old thread foldable.

Stage switches live in `continuity-engine.config.threads`: `inject` (stage 2) and `pin` (stage 3),
both default true. Stage 1 (tool + state) is always present. Disabling one stage does not rewrite
the session log; disabling the tool row returns to 0.2.7 behavior and leaves `threads.json` inert.

### Why the commit is deferred

Appending a gist/quote inside the save/load tool call would put a `user/message` between the
assistant tool-call and its tool result, exactly the pairing failure described in
`CONTINUITY-THREADS.md` trap 1. The tool therefore returns `pending:true`; the next pre-step commits.

Tests: 84 total (threads adds 18). `test/threads.test.mjs` covers explicit cut rejection, current-turn
exclusion, gist start, default balanced adjustment, load budget/missing raw, active/list/pins,
A→B→A switching, per-session persistence, read-only rules, the `makeApi()` facade, tool registration,
and the no-append pending path.

## 22. 0.3.1 — producer-owned source kind hotfix

Live 0.3.0 failed its first turn with:

```
format v4 message requires a producer-owned source kind
```

The thread injection and load quote used `source: { kind: "plugin", plugin: "dsh-continuity" }`.
The v4 session format only accepts producer-owned source kinds; an unregistered plugin name is not
one (the base compaction checkpoint uses the registered `plugin: "compact"` marker). The rejected
append aborted the turn before an assistant message.

0.3.1 changes every injected message to `source: { kind: "user" }`:

- active/rules line (`injectThreadContext`);
- load quote (`processPendingThread`);
- manual `/compact` follow-up gist header (`compactNow`);
- the semantic-summary user input (`semanticSummaryFor`).

The `[thread]` gist replacement itself is still created by the base `compactRegion` transaction with
`compactCheckpointSource` (`plugin: "compact"`), so the gist provenance is unchanged.

Tests: 85 total (threads 19). Added `contextMessage` source-kind assertion. Reinstall 0.3.1 and
restart; the failed turn itself left no invalid event in the raw log (the append was rejected before
persistence), so no session repair is needed.

## 23. 0.3.2 — post-replacement prune removal and runtime-context source

### The corrupt prune

0.3.0/0.3.1 `saveThread()` appended this after `compactRegion()`:

```js
session.append('compaction/prune', {
  shadowedRange: { start: draft.seqStart, end: draft.seqEnd },
  shadowedSeqs: [...draft.seqs],
  shadowedTokenCount: result.shadowedTokenCount,
});
```

By then the summary replacement had already shadowed that range. v4 replay rejected it:

```
compaction/prune shadowedSeqs do not name an exact current surface span
```

0.3.2 removes the append. The base `compaction/summary` already records
`shadowedRange`/`shadowedSeqs`/`shadowedTokenCount`; A4's prune remains immediately before its own
tool-result replacement, where its single seq is still current surface.

### Live repair

The invalid event was live session seq 10762 (the save at seq 10755). The original raw log was
backed up byte-for-byte before repair:

```
backups/session-0b094f6e-…-20261027-221254.v4.jsonl.zstd
SHA256 14BD80428DDABCB3A6F1EEE67AD21D94B21B7E51AF61F1C5543759A106E38BEB
```

The repair keeps the event and its seq (no renumbering) and retargets the prune to the replacement
checkpoint seq 10760 with `shadowedTokenCount: 0`; the replacement is a current surface node, so the
format check passes and the price is a no-op.

The first repair decompressed all 5,939 zstd frames and recompressed them as **one** frame. That
kept the JSONL but merged frame 0 — the **session header** — with the events. The session store
reads frame 0 as the header, so the session disappeared from the list. The final repair preserves
the frame structure: every original frame is copied byte-for-byte except the one frame containing
seq 10762; frame 0 is untouched.

```
source frames      5,939
repaired frames    5,939
frame 0            {"type":"session",…}
events             10,910
invalid prunes     0
surface tail       10884…10906
size               10,868,579
SHA256             92159A24E888CB412D1D45A8CFC5ED5FBFA03CB84F8FA5A4F1F0A1BD8057995A
```

The live file now has that frame-preserving hash; the original and the intermediate single-frame
repaired copy remain in `backups/` for forensics. The `.repaired.v4.jsonl` is the full logical log.

### Source kind

0.3.1's `{kind:"user"}` passed v4 but rendered the per-turn rules as a human chat bubble. 0.3.2 uses
the registered runtime-context source:

```json
{ "kind": "runtime-context", "form": "snapshot",
  "sections": [{ "name": "continuity:threads", "text": "…" }] }
```

The content and section text are identical. The UI renders it as a context block, not as the user
typing. The semantic-summary input remains an in-memory `{kind:"user"}` message and is never
persisted.

Tests: 85 total (threads 19). The engine smoke additionally asserts that `saveThread` writes no
`compaction/prune` at all.

## 24. 0.3.3 — self-authored rules attribution

0.3.2 already made the injection **once per turn**, keyed by `agent.lastTurn` / the latest
`turn/start` seq (`threadInjectTurn`), not once per model step. It is a `runtime-context` snapshot,
not a `user/message`.

0.3.3 adds an explicit attribution between the active line and the rules:

```text
[习惯] 下面是你自己写在 ~/.dsh/continuity/rules.md 的习惯，不是用户的新指令，也不是系统要求；
它不是任务，你可以按自己的判断采用、忽略或改写它。
```

`threadContextText(line, rulesText)` builds the block; `RULES_ATTRIBUTION` is the constant. This
matters because the rules file is authored by the instance, not by the human: the model should not
read it as a fresh external demand or a system invariant. The plugin still never writes the file.

The block is capped at 200 estimated tokens for the line and 400 for the rules; the whole block is
appended after the surface tail, so it does not touch the static prefix. If the instance still feels
the block is heavy, `continuity-engine.config.threads.inject: false` disables stage 2 while leaving
save/load/active/list and the rules file intact.

Tests: 86 total (threads 20). Added the attribution/source assertions.

## 25. 0.3.4 — attach a save to an existing thread

`save` gains optional `threadId`. The engine never decides whether two ranges belong together; the
caller/rules decide and pass the id.

- Omitted: new thread, generated id, `activeId: null` (unchanged).
- Known: the range becomes a new segment of that thread and `activeId` points at it.
- Unknown: `continuity.save: unknown threadId <id>` before the range is priced/compacted. There is no
  pending, gist, or state write.

### Shape

`thread.segments[]` holds `{fromSeq, toSeq, seqs, count, tokens, why, next, residue?, at, spanStart,
spanEnd, minutes, archiveRef, gistSeq?, compactionId?}`. Thread-level `why/next/seqs/count/tokens/
archiveRef/gistSeq` follow the **latest** segment; `seqStart`/`spanStart` stay the first segment and
`seqEnd`/`spanEnd` the latest. `tokens` is the thread total. Old entries without `segments` normalize
to exactly one segment in `threads-store.getSession()` and are rewritten with segments on the next
`updateSession()`; no old thread is dropped.

### Receipts

```
saved as T5 · seq 1200..1310 · 12.3k tokens
saved into T3 · segment 2 · seq 1310..1420 · 9.8k tokens
```

The tool result also carries `mode`, `segment`, `segments`, and `active`. The durable gist is still
committed at the next pre-step; no post-replacement prune.

### list / active / load

`listView`/`activeView` add `segments`, `lastAt`, and `display`
(`T3 · 2 段 · 最近 21:40`). `load` keeps whole-thread semantics but quotes the latest segment,
carries `segment`/`segments`, and its header says `第2/2段`; the index-only fallback does the same.

Tests: 89 total (threads 23): new, append, unknown-id-no-write, old one-range compatibility, and the
existing load test now uses two segments and asserts the latest. The real-engine smoke performs two
saves through the Core, commits through the engine, and asserts one thread with two segments,
`activeId` on it, the append receipt, and unknown-id no-write.

## 26. 0.3.5 — scan and range/select load

### scan

`continuity.scan({fromSeq, toSeq, headChars?, includeReasoning?, types?, limit?})` is read-only and
does not inject. It returns:

```json
[{ "seq": 1030, "role": "assistant", "type": "message",
   "head": "**能出图。** …", "chars": 1190, "tokens": 605 }]
```

Defaults: `types:["message"]` (categories are `message`, `tool-result`, `tool-call`, `gist`,
`compaction`, `turn`, `step`, `request`; raw event types and roles are also accepted), reasoning
excluded, synthetic `runtime-context`/`compact-checkpoint` messages skipped, 160-char heads (max
200), at most 20 items, and a payload budget of ~900 estimated tokens. `includeReasoning` restores
reasoning blocks. It never summarizes and never decides importance.

Live check on the actual avatar range:

```text
scan(958, 1050): 10 items, 787 estimated tokens, every head <= 160 chars, no [reasoning]
```

The 10 items include user/assistant text and assistant tool-call heads; `types:["user/message"]`
narrows further. This is deliberately a list, not a judgment.

### load range/select

`continuity.load` accepts, alongside `id`/`budgetTokens`:

- `fromSeq`/`toSeq`: both or neither; restrict the thread's seqs to the interval;
- `select:[seqs]`: exactly these seqs, usually from scan; not tail-truncated;
- both: the select must lie inside the range.

The quote uses `eventText(..., {includeReasoning:false})`; reasoning-only events are skipped. The
result adds `segs` (the seqs actually injected), `range`, and `select`; `injected`/`tokens` describe
the same set. An explicit select that is outside the thread or outside the range returns
`seq-not-in-thread` / `select-outside-range` without writing pending state. The default no-range
call still quotes the latest segment; the old object shape and the 8k budget are unchanged.

The pending text says either `第N/M段`, `范围 A..B`, or `范围 A..B · 选择 N 条` (or `选择 N 条`),
so the receipt says which part was used. Tests: 93 total (threads 27), including reasoning-free scan,
scan cost <1k, exact select with `segs`, default old-shape load, range load, and rejection paths. The
real-engine smoke also does a range/select load and a scan after the two saves.

## 27. 0.3.6 — tags sidecar (find / scan / load)

### tags.json

```
~/.dsh/continuity/tags.json
{ version, tags, runs: [[from,to,id], …], overrides: { "<seq>": id }, updatedAt }
```

`resolveTag(seq)` = override → last containing run → `T0`. Runs may overlap; later runs win.
Missing and corrupt both return the empty T0 state, set `missing`/`corrupt` on the read result, and
never throw. `readTags`/`updateTags` are serialized/atomic; `tags.json` is the only new file and the
session log is never written by the tag layer.

### find / tag / retag / tags

`find({id, after?, before?, limit?})` returns `{seqs, count, first, last, span}` and defaults to
limit 20. `seqs` come from the message universe (user/assistant, synthetic runtime/checkpoint
skipped) resolved through the tags plus exact overrides. `after`/`before` are inclusive seq bounds;
`span` uses the first/last event `time`, or null. `tag({seqs,id})` writes overrides;
`retag({from,to})` moves all runs and overrides and drops the old tag; `tags()` reports
label/status/runs/overrides/lastSeq. The default find payload is <200 tokens; the scan list keeps its
~900-token budget, so 50 turns stay under 2k.

### scan / load

`scan` accepts `seqs` as an alternative to `fromSeq`/`toSeq`; all other defaults are unchanged.
`load` accepts:

- a **thread id**: old latest-segment/range/select behavior; sets active;
- a **tag id**: `find(id)` and take earliest 3 + latest 5, visible/non-reasoning, then trim the
  largest events until the budget is met; `active` is unchanged;
- `seqs:[...]`: exact visible seqs (no tail truncation); `active` is unchanged.

Tag/seqs loads return `segs`; their pending text starts `[取]` and says `默认最早3+最新5` or
`按指定 seqs`. `load` with a tag and `fromSeq/toSeq/select` is rejected (use `seqs`). The old
`load(threadId, budgetTokens)` test remains green.

### Auto tag

At each pre-step, `autoTagCompletedTurn` finds the latest completed `turn/start..turn/end` range and
writes one run if that exact range is absent. T is the active thread id, or `T0`; label is the thread
label or `未分类`. This is sidecar-only and never appends to the raw log. A missing/corrupt tags file
is recovered with one warning.

Tests: 104 total (threads 27, tags 11), including resolve precedence, missing/corrupt fallback,
find/filters/span/empty, tag+retag immediacy, tool actions, tag/seqs loads, scan seqs, 50-turn cost,
budget trim, and the real-engine smoke's thread-tagged turn, idempotent second auto-tag, and T0
fallback.

## 28. 0.3.7 — tag fixes from live use

### P1 tag loads must not move active

`processPendingThread` used to treat every `pending.kind === 'load'` as a thread load and set
`activeId = pending.id`, so `load({id:"T2"})` made the next `[线]` say “当前：无”. 0.3.7 gates the active
update on `pending.mode`: `thread` (or legacy no-mode) moves the pointer; `tag`/`seqs` only append the
quote and clear `pending`. `tags()` rows include all threads, with `active` from the real `activeId`.

### P2 find(T0) is the complement

`find({id:"T0"})` now returns `{seqs:[], ranges, count, first, last, span, complement:true}`, where
`ranges` are the contiguous seq spans whose resolved tag is T0 (explicit T0, untagged, and T0
overrides inside other tags). The span is 0..max event seq (or max run/override); `limit` caps the
number of ranges, not the total count. T2/T-n find remains the message seq list. So T2=[958,1330]
yields T0 ranges [0,957] and [1331,max], never 958–1330.

### P3/P4 names and labels

`tags()` rows are `{id, label?, display, count, runs, overrides, lastSeq, active, ...}`; `display` is
the label, else the first 8 chars of the id. `tag({seqs,id,label?})` creates/updates the label. The
auto tag keeps an existing real label and replaces an id-placeholder label with the thread label.
Tag load receipts use `selectionLoadText` with one display name, so `[取] Avatar` rather than
`[取] T2 · T2`.

### P5/P6 find bounds and small items

`after` is strict `seq > after`; `before` is strict `seq < before`; `limit` is stable ascending.
Empty tags return count0. Missing/corrupt tags fall back to T0 and warn. `tag` writes update
`updatedAt` (and the test asserts it).

Tests: 108 total (threads 27, tags 15). The engine smoke additionally loads a tag while a thread is
active, proves `activeId` and the active line stay, checks the tag row’s `active:false` and the
thread row’s `active:true`, and verifies the no-duplicate receipt.

## 29. 0.3.8 — tag ranges

`tag` accepts `{fromSeq,toSeq,id,label?}` as well as `{seqs,id,label?}`. The range form appends one
run `[from,to,id]` (the same record the auto-tagger writes) and returns
`{ok:true,id,range:[from,to],count:to-from+1}`. It does not write per-seq overrides; the existing
`seqs` form still writes overrides and its behavior is unchanged. Per-seq overrides still beat any
run, and later runs still beat earlier runs. Adjacent runs are not merged.

`find` now also returns coverage for a tag: `ranges` (contiguous seq spans where resolve(seq) === id),
`covered` (their total length), and `rangeFirst`/`rangeLast`/`rangeSpan`. This makes a range tag cover
tool events as well as messages, while `seqs` remains the message list. `find(T0)` remains the
complement with `seqs:[]` and `ranges`.

`untag({fromSeq,toSeq})` appends a T0 run and deletes overrides in the range, returning
`{range,count,removedOverrides}`. The tool exposes `untag`; `retag` moves the whole run unchanged.

Tests: 110 total (threads 27, tags 17). Coverage includes a range run with override priority,
tag→find over the whole segment, retag of a run, untag clearing the range, no adjacent-run merge,
tool range/untag, and the earlier P1–P6 cases. No raw/gist/save changes.

## 30. 0.3.9 — tags() count semantics

The 0.3.7/0.3.8 `tags()` row used `count = runs + overrides`; a thread tag with one run over ten
thousand events displayed `count: 108`-style entry counts. 0.3.9 computes actual resolved coverage
once over `0..maxSeq` (max of session events, run ends, and override keys) and exposes:

- `entries`: runs + overrides (the old number);
- `events`: seqs whose resolved tag is this id;
- `count`: alias of `events` (kept for the existing field name, now actual events).

T0’s `events` is its complement; thread rows without a run keep events 0. The `tags` action reads the
session max seq through its existing `sessionQuery` so the T0/tail counts are over the whole span.
No other tag/load/save behavior changes.

Tests remain 110 total (tags 17); the assertions now check `entries`/`events`/`count` on a range run
and an override tag.

## 31. 0.4.0 — fold provenance, aliases, tags.md, first/last, slim injection

- **Gist T.** `gistHeader` accepts `t` and renders `T=...` inline. The engine computes it with
  `tagCoverageForRange(tags, from, to)` (resolve per seq, counts sorted desc), for pressure, manual, and
  thread-save gists. `threadGistText` renders the segment's `tCoverage` and `thread=<segment index>`.
- **Folds.** The engine records each compacted shadowed range and summary seq in
  `~/.dsh/continuity/folds.json` per session. `find` splits its message `seqs` into `visible`/`folded`;
  T0 also reports empty visible/folded and `covered`. A load selecting a folded seq prepends
  `[已折叠于 gist seq=N]`; the seqs are also returned as `folded`/`visible`.
- **Alias.** Threads accept `alias` on save (new or append). Auto-tag writes the alias as T when
  present; `tags()` display is alias → label → short id; the alias row is active. tags.md shows
  symbol → thread id.
- **tags.md.** `tags.json` entries accept `keywords`. Every tag/untag/retag plus alias save and auto
  tag regenerates `tags.md` via `renderTagsMd`; the file is never read. Hand edits are overwritten.
- **first/last.** Tag loads accept `first`/`last` (default 3/5); `first:0` or `last:0` means omit that
  end; both zero is rejected. Thread/seqs loads reject first/last. The receipt text says the actual
  selection.
- **Injection.** The runtime-context block is `[线]` + `[标签] 当前 <alias>（label）· 另有 N 条`, then
  `[习惯] <H2 headings> · 全文 ~/.dsh/continuity/rules.md`. The full rules text is no longer injected.

Tests: 114 total (threads 27, tags 21). The key cases are gist T pure/cross, find folded/load
annotation, first/last, tags.md overwrite, alias display/active, and the compact habit line. No save/
load segment semantics, 8k fallback, or tool-pairing behavior changed.

## 32. 0.4.1 — metadata-only tag, tag alias, explicit-only T0 counts

- `tag` accepts no seqs/ranges when at least one metadata field is present:
  `tag({id,label})`, `tag({id,keywords})`, `tag({id,alias})`. It updates tags.json, advances
  `updatedAt`, writes tags.md, and returns the updated tags() row. No run/override is written, so no
  seq changes hands.
- Tag records now accept `alias` (and `tag({id,alias})` also sets the matching thread record’s alias).
  `tags()` rows include alias; display is tag/thread alias → label → short id; the alias row is active;
  auto-tag writes the thread alias; tags.md’s symbol column is `alias ?? id`.
- T0 counting was initially explicit-only in 0.4.1; 0.4.2 replaces that with the complement so it
  matches `find(T0).count` (see §33).
- Existing `tag({seqs})` and `tag({fromSeq,toSeq})` keep their behavior; they may additionally carry
  alias/label/keywords.

Tests: 116 total (threads 27, tags 23). New coverage: metadata-only label/keywords/alias, tag alias
setting the thread alias and active row, tags.md symbol, and the smoke path tag alias → auto T9 →
`[标签] 当前 T9`.

## 33. 0.4.2 — unified T0 counts and display-only gist T

- `tags()` T0 `events` is the complement seq count over 0..max, equal to `find(T0).count` (including
  folded seqs). Other tags’ `events` equal `find(id).covered`. `tags.md` renders the same row value.
  `entries` remains runs+overrides (sidecar records, not messages); `count` is an alias of `events`.
  A fold does not alter tags, maxSeq, or these numbers.
- `tagCoverageForRange(tags,from,to,{threads})` returns display labels: alias → label → short id,
  excludes T0 when any non-T0 tag is present, uses T0 only for an all-T0 range, sorts by event count,
  keeps at most three, and appends `+N`. `threadGistText` and `gistHeader` consume that label; the
  field order remains `thread=… · T=…`.
- No changes to find’s complement/ranges, tags() display/keywords, tags.md generation, or save’s
  segment merge/pending/8k behavior.

Tests still 116 (threads 27, tags 23): the T0 test now asserts `tags().T0.events === find(T0).count`
before/after a fold, and the gist test asserts display, T0 omission, three-tag cap, and thread/T field
order.

## 34. 0.4.3 — canonical alias identity and find count/page

- Alias is display only. `tag`, auto-tag, run writes, and find/load resolve alias → canonical thread id.
  Auto-tag writes `active.id`; the tag entry may carry `alias` for display. `load({id:"T3"})` canonical
  resolves to the thread, not a second tag.
- Migration: on tags/find/load/tag/auto, `migrateAliasTags` moves every alias-named run/override into
  the canonical thread tag, ensures the canonical alias/label, deletes the alias tag record, and writes
  tags.md. So `tags()` has one T3 row, `find(T3)` equals `find(threadId)`.
- `find` count semantics: `count` = total covered events for the tag (including folded), independent
  of `limit`; `seqs` = this page (`seqs.length <= limit`); `covered` = `count`. T0’s count is the
  complement. The tags()/tags.md `events` use the same total.
- Untouched: `ranges`/`complement`/`visible`/`folded`, tags() display/keywords, tags.md generation,
  save merge/pending/8k.

Tests: 117 (threads 27, tags 24). New coverage: alias migration to canonical, find(T3) ≡ find(threadId),
load(T3) → thread, tag(T3) writes canonical, count stable across limit, and the auto-tag canonical smoke.

## 35. 0.4.4 — default save clamps to current T; primary-only gist T

- Default save (`fromSeq`/`toSeq` omitted) still uses the latest-200-message ceiling, but additionally
  clamps its start to the first surface node at/after the start of the tag run containing the selected
  end. If the run is shorter, the save is shorter. Explicit from/to is passed through unchanged. This
  is selection only; pairing, the 8k fallback, and folding math are unchanged.
- `tagCoverageForRange` now returns one primary display (largest event count) plus the number of other
  non-T0 events, e.g. `T3 +2`; no comma list. Display is alias → short label → short id, one form only.
  All-T0 stays `T0`. `thread=` remains before `T=`.
- Tests: 118 (threads 28, tags 24): selectSaveRange minStartSeq clamp and explicit bypass, tagRunStartAt,
  and primary+secondary labels.

## 36. 0.4.5 — dominance block, default append, auto-bound new threads

- `dominanceStartSeq(tags,end,{islandMax=5})` in threads.mjs starts at the run containing end, walks
  earlier runs: own runs join; other-T runs of <=5 events are islands crossed; a larger other run is a
  boundary. 0.4.4’s run-start clamp is replaced by this block start; `selectSaveRange` minStartSeq is
  unchanged. Explicit from/to still bypasses it.
- `prepareSave` without threadId appends when the current T resolves to an existing thread id or
  alias (active:false is not a filter); T0 or unbound T creates. A new non-T0 thread inherits the
  current T alias and is active, so `[标签]` has a T immediately. New T0 threads stay inactive.
- Header label remains primary + secondary count (`T3`, `T3 +2`), display one form only; 0.4.4 already
  changed this; 0.4.5 keeps it.
- Tests: 119 (threads 28, tags 25): dominance islands vs real boundaries, selectSaveRange clamp, and
  primary+secondary labels.

## 37. 0.4.6 — load withReasoning

- `load(..., withReasoning:true)` applies to thread, tag, and seqs loads. Default `false` leaves the
  0.4.5 8k/no-reasoning path untouched.
- The selected visible entries are sorted chronologically and share one 16,000-token body+reasoning
  budget. Each assistant body pairs its own reasoning blocks, or the nearest reasoning-only event
  before it in the same turn. Pairing is silent when absent; user messages never pair.
- Reasoning renders separately (`[reasoning]`; truncated label `[reasoning · 截断]`). A reasoning over
  800 estimated tokens keeps a 150-token head and 650-token tail. Bodies plus reasoning stop at the
  budget; remaining entries are counted as `skipped`.
- Receipts add `reasoningInjected`, `reasoningTokens`, `skipped`; `tokens` is the actual body+reasoning
  total and `budget` is 16,000 for this mode. Text headers say `含 reasoningN 条 · skipped K`.
- Gist generation and scan do not include reasoning.

Tests: 121 (threads 28, tags 27): internal and preceding reasoning pairing, truncation, 16k stop/skipped,
thread and tag paths, default no-reasoning output, and the tool parameter.

## 38. 0.4.7 — delete, header counts, label protection, alias id resolution

- `delete({id,force?})` allows zero-segment/zero-token threads; otherwise `force:true` is required.
  Before mutation it writes `<id>-<ts>.json` under `~/.dsh/continuity/deleted/` with the raw/normalized
  thread and tag entries/runs/overrides. It then removes the thread, its tag rows/runs/overrides, regenerates
  tags.md, and returns `{ok,id,backup}`. No automatic deletion.
- `[线]` is `当前：label（N 段 · M tokens）` (M=sum of segment tokens), with `（活动：symbol）` when
  the active-flag thread differs from `activeId`. `另有 K 条` is unchanged.
- Existing thread saves keep their label; `relabel:true` is the only override.
- tag/retag resolve tag id first, then alias (tag or thread); unknown metadata retag returns
  `unknown-tag-id` instead of creating an empty record. Retagging an alias to its own canonical is an
  idempotent success.
- tags.md omits zero-event rows; list reflects threads after explicit deletion. JSON shapes remain
  read-compatible with 0.4.6.

Tests: 122 (threads 28, tags 28): empty/forced delete plus backup, tag-row removal and zero-event md,
header segment/token/activity mismatch, label protected and relabel, alias retag no-op/unknown.

## 39. 0.7.6 — target-addressed peer route

`POST /dsh-continuity/peer` on the Host's existing Web server. Body:
`{ "to": "session-...", "from": "创", "text": "..." }`.

- `to` is mandatory and must be an exact live main-session id. Lookup is a
  `Map<sessionId, agent>` fed by `agent/created` / `session/disposed`. A missing target returns
  `404 target-not-live`; there is no active, newest, or owner fallback.
- Delivery is `agent.followup(userMessage("[from] text"))`: fresh id, role user,
  `source.kind: "user"`; no raw `session.append`, no direct event construction.
- The route is loopback-only, POST-only, 16 KiB body and 8,000-character text limits.
- It is independent of the Coo pet bridge; it does not open or replace `/coopanion/pet`.
- `followup` queues for the next turn; a 200 means accepted, not replied. A reply is a separate
  call from the other side.

Tests: 131 (peer 5, route 1): exact target/no fallback, registry ignores subagents/no-followup, payload
validation, source/id shape, loopback/method/body refusals, and panel-disabled route mounting.

## 40. 0.7.7 — peer_message preset tool

The continuity preset mounts `peer_message({ to, text, from? })` next to `continuity`. It shares the
same singleton live-agent registry as the route.

- `to` is required and exact; `from` defaults to `Continuity`; text is 1–8000 chars.
- Delivery is `target.followup(peerMessage(...))` with a fresh id and `source.kind: "user"`; no raw
  session append and no owner/active fallback.
- Result is `{ok,to,from,queued:"next-turn",id}`; unknown target throws `peer_message: target-not-live`.
- The tool is preset-scoped, so standard sessions do not see it; the Host route remains available for
  external callers such as 创.

Tests: 134 (peer 5, route 1, peer-tool 3): exact target, default/custom from, source/id/prefix,
unknown-target refusal, and input validation before delivery.

## 41. 0.7.8 — one-shot tag rejection display

The Tag gate's decision rules are unchanged. `tag-reject.json` is now a two-step display record:

- rejection writes `{turn,token,kind,reason,shown:false}`;
- the first consuming pre-step renders the existing `[打标·退回]` text, then writes
  `shown:true` and `shownAt` (does not delete);
- the next consuming pre-step deletes the file without rendering;
- a second rejection for the same turn preserves `shown:true`, so it cannot render twice.

`renderTagRejectHeader` keeps the existing wording and `turnmap ... set --turn N --tag <Tx>` line.
All Tag-gate writes remain on `userMessage()`; T99 rejections still never append `turn-tags.jsonl`.

Tests: 138 (peer 5, route 1, peer-tool 3, tag-reject 4): first render/mark, second-step delete,
same-turn no-reset, new-turn render, and exact header text.

## 42. 0.7.9 — stale rejection and one-steer cleanup

- `consumeTagReject` now accepts `isResolved(turn)`. The engine header passes the same `tagged`
  set computed from `turn-tags.jsonl` (last write wins per turn is equivalent for this existence
  check). A resolved turn deletes `tag-reject.json` without rendering.
- The two rejection paths no longer call `appendToSession`; they emit one `steer` whose first line
  is the old short message and whose remainder is the complete error count/examples. The header
  remains the fallback when steer cannot be delivered.
- Decision rules and `userMessage()` source/id discipline are unchanged.

Acceptance target: T99 then a legal T14 must not render a stale header; T99 without repair must render
once and disappear; one steer per rejection; no new `turn-tags` rows or `gate-errors`.

Tests: 139 (peer 5, route 1, peer-tool 3, tag-reject 5): resolved delete, one-shot display, same-turn
no-reset, new-turn render, and exact header text.

## 43. 0.8.0 — dispatch probe

The Host listener's `agent/turn-stopping` handler writes `dispatch-probe.jsonl` before reading
`continuityState.engine`:

```json
{"at":"...","event":"agent/turn-stopping","turn":1196,"enginePresent":true}
```

The engine entry probe `hook-probe.jsonl` now includes `taggedSize` alongside `hasAgent` and
`canSteer`. Comparison:

- both files have the turn → dispatch and engine entry both happened;
- dispatch only, `enginePresent:false` → engine was not ready;
- dispatch only, `enginePresent:true` → engine returned/threw before its entry probe;
- neither → the Host did not dispatch that turn-stopping.

No decision rules or user text changed. Tests: 140 (dispatch 1) verify probe-before-engine and the
null/true engine distinction.

## 44. 0.8.1 — dispatch identity fields

`dispatch-probe.jsonl` records:

- `engineCallable`: `typeof continuityState.engine?.onTurnStopping === 'function'`;
- `agentSession`: the session id carried by the event's agent;
- `continuitySession`: the session the mounted engine has actually served
  (`continuityState.engineSession`, set at engine `onTurnStopping` entry);
- `foreignSession`: both ids are present and differ.

`hook-probe.jsonl` additionally records `agentSession`. The fields only diagnose: a foreign session
is noise for this gate; a local event with dispatch but no hook points at the index/engine fallback;
neither file is a Host non-dispatch. Tests: 140 (dispatch 1 covers the fields and foreign flag).

## 45. 0.8.2 — gate messages are runtime context

The Tag gate's `steer` still holds the current turn open, but its message now uses
`source:{kind:"runtime-context", form:"notice", sections:[{name:"continuity:tag-gate",text}]}`
instead of `source:{kind:"user"}`. The `[闸] TAG：` / `[闸·打标]` marker stays in the text.

- The UI no longer attributes the gate to the person as a user bubble; it is a context block.
- The model still receives the text (the gate must explain the hold); this is not a full hide.
- Same-turn `agent.steer`, decision rules, headers and `tag-reject` behavior are unchanged.
- Peer messages still use the real `userMessage()` path; only the gate source changed.

Tests: 141 (threads 31): source kind/form/section and marker, plus the existing gate suite.

## 46. 0.8.3 — first-line TAG declaration

`findTagDeclaration` (new `src/tag-detect.mjs`) accepts the first non-empty, non-fenced line and the
last five non-empty, non-fenced lines. If both contain a TAG, the last-five candidate wins, preserving
the old tail priority. Fenced examples remain ignored.

`onTurnStopping` now uses this helper instead of only reverse-walking five lines, so a long report
with `TAG:` on its first line is accepted. The pre-step auto-copy already considered first/last; this
aligns the turn gate with the documented rule.

Tests: 147 (tag-detect 6): first-line, last-line, last-wins, fenced-only, fenced-first followed by
real tag, and candidate de-duplication.

## 47. 0.8.4 — real-user filtering

`latestUserTurn` and the pre-step turn map now require `source.kind === "user"` for both
`user/message` and `agent/inbox/spliced` entries. `runtime-context`, `time-context`, delivery notices,
and the gate's own `continuity:tag-gate` notices are skipped.

This removes the `[新标签?]` / `[暂停]` quotations of runtime/time context. The helper lives in
`src/user-turn.mjs`; the gate's latest-user selection and the `userFirstBySeq` map share it.

Tests: 151 (user-turn 4): time/runtime skipped, spliced user selected, only-context → null, and source
lookup precedence.

## 48. 0.8.5 — current turn is not debt

`closedTurns` now filters `turn < currentTurn`, using `agent.lastTurn` (fallback: latest
`turn/start`). The current open turn is excluded from `[打标?]` and `tag-debt.json`.

`[暂停]` is emitted only when the previous completed turn has a real user quote; an empty quote now
omits the whole line instead of printing `「」`. The `[打标?]` list remains for genuinely older
missing turns.

Tests: 151; header behavior is exercised live (turn 1210: no `缺 1 轮`, no empty `[暂停]`).

## 49. 0.8.6 — surface-floor start and skippedRange

`resolveSaveStart` keeps the normal save start at `surface[0]` even when an explicit `fromSeq` is
below it; it never throws `not a surface node`. `detectSkippedRange` reports
`{from,to,events}` for the uncovered interval before `surface[0]` (message events only), records
`save-hole`, and the result/receipt carry `skippedRange`.

`preflight` now takes the actual segment start/end, so its plan and the landed segment share one
source. Nothing auto-fills the hole; `backfill:true` is reserved for 0.8.9.

Tests: 155 (save-start 4): below-surface fallback, at/above/no explicit, hole count, no-hole/no-range
cases.

## 50. 0.8.7 — save-hole noise and T0 machine sources

- `detectSkippedRange` returns null when the interval has zero message events; no receipt/header
  noise for a purely structural gap.
- Peer messages carry `source.peer:true` (still `source.kind:"user"` for the UI) and
  `contentUndecided` skips `source.peer`, `runtime-context`, `time-context` and other non-user
  sources. Machine steers/peer notes no longer create T0 undecided debt.
- Normal save emits `planNote` when `preflight.plan[0].from !== segment.fromSeq`, naming both values
  and the reason (plan only counts turn-attributed content events).

Tests: 168 (save-start 4, t0 13): zero-event suppression, machine-source filtering, and existing
save-start cases.

## 51. 0.8.8 — peer prefix fallback for T0

The Host may persist only `source.kind:"user"` on a peer-delivered user message, dropping the extra
`source.peer` flag. `contentUndecided` therefore also skips content starting with `[创]`, `[闸]`, or
`[闸·打标]`; these are the stable prefixes written by the peer route and the Tag gate.

This removes the remaining T0 debt from cross-session peer notes and gate steers. The `source.peer`
flag remains as an additional, non-required marker.

Tests: 168 (t0 13): `[创]`/`[闸]` with only `kind:"user"` are skipped; real user content still
counts.

## 52. 0.8.9 — historical backfill

`save({fromSeq,toSeq,backfill:true,threadId?})` does not call `selectSaveRange`. It reads
`sessionQuery.readSession` events, keeps `user/message`, `assistant/message`, `tool/call`,
`tool/result` in `[fromSeq,toSeq]`, drops a leading tool/result or trailing tool/call, and appends
one segment to an existing thread (active by default).

- Strict overlap with any existing segment → `range-already-covered`.
- Same gates: `t0-undecided`, `turn-untagged`, `tags-gap`; empty content → `backfill-empty`.
- Returns `mode:"backfill"`, `surfaceTouched:false`, `adjusted:false`, actual `seqStart/seqEnd/count`,
  `seqs`, and `requestedRange` (requested vs content boundary).
- No live surface mutation, no pending gist, no make-surface path.

Tests: 172 (backfill 4): whitelist/range, edge-pair trim, segment boundaries/tokens, strict overlap.

## 53. 0.8.10 — ordered segments after backfill

`normalizeThread` sorts segments by `fromSeq`. This restores the invariant every reader relies on:
the last segment is the chronologically latest, so `seqEnd`, `why`, `next`, gist index, `coveredTo`
and `at(-1)` projections stay correct after a historical backfill.

Backfill inserts the new segment at its sorted position, reports that position, and does not let the
archival segment's `why/next` become the thread's latest metadata. `label/why/next` are optional for
backfill and receive deterministic defaults.

The backfill segment still inherits the thread's current `gistSeq`/`compactionId` through
`normalizeSegment`; it is not recomputed for the historical range. If this is undesirable, that is a
separate backfill-gist design change.

Tests: 173 (backfill 5): out-of-order normalization keeps `seqEnd`/`why`/`next` from the latest
segment.

## 54. 0.8.11 — fieldless backfill validation

The tool validator's `save` branch previously required non-empty `label/why/next` for every save.
It now skips that requirement when `backfill:true`; normal saves still enforce it in the Core.

Core's backfill parser generates `历史回补 <from>..<to>` and `检查这段原话` when those fields are
absent, so the archival segment never carries empty `why/next`. Tests: 173; the tool-level path is
exercised live (fieldless backfill).

## 55. 0.8.12 — content time is not write time

A backfill segment now sets `at = spanEnd` (when its content happened) and `archivedAt = now` (when
it was appended). `normalizeSegment` preserves `archivedAt`.

`normalizeThread` takes thread `updatedAt` from the latest segment's `spanEnd` instead of the
source `updatedAt`/`at`; `saveBackfill` writes the latest content's `spanEnd` as the thread
timestamp. This prevents a historical backfill from making the thread look recently active.

Q2 of the user-facing table was corrected: system ordering is fixed, but a reader can still confuse
"when the note was written" with "when the event happened" unless it uses `span` or the event
timestamp.

Tests: 173; backfill assertions cover `at === spanEnd`, `archivedAt`, and `normalizeThread`
`updatedAt` from the latest `spanEnd`.

## 56. 0.8.13 — normalize the persisted file too

0.8.12 normalized old backfill timestamps only in the in-memory `normalizeThread` view; direct
`threads.json` consumers still saw the old write-time `at`.

`migrateThreadsFile` now runs once at plugin startup:

- reads every session, normalizes its threads, compares with the raw JSON;
- on change, writes a `threads.json.bak-normalize-*` backup and calls `updateSession` so the file is
  rewritten in normalized form;
- old backfill rows get `at = spanEnd` and `archivedAt = old at` (the old write moment is preserved,
  not discarded); thread `updatedAt` becomes the latest content `spanEnd`.

Tests: 174 (migrate 1): old `历史回补` row is normalized on disk, `archivedAt` is preserved, and the
backup exists.

## 57. 0.8.14 — boundary-silent header

The header now follows “正常不吵，越界才说”:

- auto-assignment success is silent; only failure/ambiguity/active-line change speaks;
- `[新标签?]` requires zero candidates, ≥40 chars, non-machine text, 30-day text cap, and 20-turn
  cooldown; it is mutually exclusive with `[候选]`;
- `[话题?]` uses keywords/anchors only (label weight 0), generic weight 0; needs one exclusive word
  (precision ≥0.5, hits ≥5) or ≥2 non-generic words; score gap ≥2; one target; 10-minute same-target
  cooldown;
- `[归拢]`/`[心境]` no longer auto-broadcast; `[接手]` only after load and one line;
- `[存?]` requires 8+ unseen content messages, 20+ turns from segment end, and once per
  `(thread,toSeq)`;
- `[规则膨胀?]` once per size signature;
- skill body injects only when the skill set changes; the `[技能] 正在用` line remains.

Self-check: `node bin/noise-selfcheck.mjs`. Tests: 188 (topic 7, inject-policy 7).

## 58. 0.8.15 — anchors do not promote generic words

`topic.mjs` now treats anchors only as a presence requirement; they never move a generic word into
`strong`. `strong` is strictly non-generic; `exclusive` requires the word stats (precision ≥0.5,
hits ≥5). The `[话题?]` display marks a generic anchor as `(泛·锚)` instead of calling it hard
evidence.

`[接手]` now requires `handoff-pending.json` to have the current `process.pid` and be younger than
10 minutes. A pre-restart pending is deleted without firing. Save still does not create a pending.

Tests: 189 (topic 8, inject-policy 7).

## 59. 0.8.16 — first-miss TAG prompt

The first missing-TAG steer is no longer the bare `[闸] TAG：`. It now says:

```text
[闸] 收尾前，先用最后一行总结本轮主题：
TAG: <最符合的 T 别名；没有就写一个 2–30 字的新词> — 一句话理由
例：TAG: T14 — 折叠边界
```

The parser still requires the literal `TAG:`; “总结本轮主题” is explanatory, not a replacement.
Later errors keep the detailed `EXPECT` block. It lowers accidental gibberish, but does not stop a
deliberate 2–30 char unknown word from auto-creating a T.

Tests: 189; selfcheck also asserts the new prompt text.

## 60. 0.8.17 — confirm new names with evidence

New-word confirmation now:

- asks only y/n and says “这一轮最后一行只写 y 或 n；不要写 TAG”;
- accepts `y` immediately before a TAG line (last-line parser looks back one line);
- requires the word to appear in the current user message or assistant body, excluding TAG
  lines and `[闸…]` gate text;
- rejects a word within edit distance 1 of an existing label and names that alias;
- splits declarations only on `—`/`–`, so `F-35`, `COVID-19`, and `D-Day` stay intact;
- uses a placeholder new-word example rather than the existing T16 label;
- records the confirmed token in `turn-tags.jsonl` and clears pending on the safety valve.

Tests: 194 (tag-confirm 5).

## 61. 0.8.18 — backfill uses the same gate rules

The declaration-as-record path in the header builder (`tagLineOf`) used a separate ASCII-hyphen
split and `resolveTagToken`’s default `allowCreate:true`. That meant a backfill could silently create
a tag without y/n.

It now uses `tagTokenFromDeclaration(line)` and `resolveTagToken(token, { allowCreate: false })`:
existing aliases/ids can be copied, new words are `new-pending` and left for the gate. `F-35` is no
longer truncated to `F`.

Tests: 194; selfcheck asserts the backfill line uses `tagTokenFromDeclaration(line)`.




