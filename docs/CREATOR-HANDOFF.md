# Handoff to the Creator-mode instance

> **Historical.** This was the handoff that started the compaction work. Current operating
> contract is `docs/NEW-INSTANCE-HANDOFF.md`; current mechanism is `docs/ARCHITECTURE.md`.

You are picking this up because the standard-mode session that wrote it could not inspect or
replace `ctx.compaction`. That session's context ends here; this file is the record. You are not
obliged to continue it — but if you do, these are the exact gaps.

## What is already decided

- Goal: replace the threshold-and-cliff compaction with a **band controller**: keep a verbatim
  recent window, remove a small oldest slice per pass, never fold into the protected tail.
- The pure policy is implemented and tested in `src/policy.mjs` (9 tests). Do not redesign it
  before running the tests.
- The adapter must **extend** `BasicCompactionEngine`, not reimplement the transaction.
- **One engine per context.** The existing `compaction-basic` entry must be replaced, not
  accompanied by a second engine.
- First experiment should be **config-only** (see `docs/API-NOTES.md` "Config-only quick win"):
  override `thresholdRatio: 0.92`, `retainRatio: 0.5` on the existing entry. If that already
  gives the desired feel, the custom engine may not be worth its cost.

## What you need to inspect (in this order)

1. `cordis_inspect_list` — enumerate providers.
2. `cordis_inspect_query` on the `Config` provider — find the loader entry whose name is
   `@deepseek-ai/dsh-compaction-basic`. Record:
   - its loader id and tree id (the id a patch must target),
   - its current `config` (thresholdRatio / retainRatio / headroomTokens),
   - whether any modelPolicies already exist.
3. `cordis_inspect_query` on the token-meter provider — record the exact method names/signatures
   for "used tokens" and "window tokens" for a routed request.
4. `cordis_inspect_query` on the session provider — record how to enumerate surface nodes
   (`seq`, node kind, role), and how to get the first/last node for a range.
5. Check the exports of `@deepseek-ai/dsh-compaction` actually present in the runtime:
   `toolPairingBalancedBefore` / `toolPairingBalancedAfter`.

Write the answers into `docs/API-NOTES.md` under a new "Measured at runtime" section. Do not rely
on the npm types alone; the app may be a newer `0.2.x`.

## Provenance is part of the policy

`src/provenance.mjs` is already written and tested. Wire it in **before** removing the checkpoint
preamble:

1. In `compactIfNeeded`, after selecting `{ start, end, count }`, set
   `this.pendingHeader = gistHeader({ sessionId, startSeq, endSeq, count })`.
2. Override `summarize()`: call `super.summarize(...)`, then
   `annotateSummary(base.summary, header)` (confirm the field name).
3. Add `SYSTEM_CONVENTION` as **one** system-prompt section. It must not be inside the compacted
   range, or it will be folded away.
4. Leave the fixed checkpoint preamble in place for the first version. Removing it means writing
   the replacement transaction yourself — do that only after the gist labels and the standing
   convention are verified.

The target model experience is not "a checkpoint happened"; it is:

> I have the gist of that stretch. Exact details: `log:…#seq=…`. If the original is gone, say I
> only remember the gist.

## Then fill `src/engine.mjs`

Only two methods are missing:

- `measure(agent)` → `{ estTokens, windowTokens }`.
- `oldestRange(agent, budget)` → `{ start, end }` or `null`.

Rules for `oldestRange`:

- never start at surface position 0 if it is the system message;
- inclusive span, both edges balanced (`toolPairingBalancedBefore` / `After`);
- stop before the protected tail;
- if no balanced range fits `budget`, return `null` (the caller falls back to the base backend).

Keep `compactIfNeeded`'s overflow branch delegating to `super.compactIfNeeded(...)`.

## Acceptance

1. `node test/policy.test.mjs` — 9/9.
2. Scratch profile loads the plugin inert (`enabled: false`) and logs once.
3. Enable it; run a disposable conversation long enough to cross 65%.
4. Observe: passes are small (≤ `maxPerBatch`), recent messages stay verbatim, `/compact` still
   works, overflow still recovers.
5. Ask about a detail that exists only in a compacted range. Expected: it cites the `[gist]`
   header / pointer and says it only has the gist (or retrieves), not a confident fabrication.
6. Compare against `../sim/results.json`: event count per 100 turns, median drop, p90 drop.
7. Keep the previous entry id and config in the handoff so rollback is one line.

## Do not

- Do not insert a second `compaction-basic` row.
- Do not patch the desktop profile first.
- Do not claim "continuous self"; the seam is policy, not personhood.
- Do not delete the raw/archived transcript before verifying the summary and the new ranges.

## Files

- `src/policy.mjs` — pure controller; do not change without updating tests.
- `src/engine.mjs` — the two TODOs.
- `docs/API-NOTES.md` — contract, config-only quick win, constraints.
- `../sim/` — the simulator and its numbers.
- `../README.md` — the Coopanion-side patch this mirrors.
