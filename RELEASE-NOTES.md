# Release notes — 5.0.0 candidate

## Current architecture

- Public memory resonance and unified fold default off; local overlays use explicit per-session allowlists.
- Canonical raw events are indexed immediately for lexical fallback without a model call.
- Completed Host turns enter a stable, deduplicated background archival queue.
- The worker writes summary/vector deltas atomically and resumes pending work after restart.
- Unified fold verifies complete raw coverage and reuses existing turn summaries, including complete long-turn chunks.
- Missing or stale summaries are still generated during fold; open turns remain protected.
- `read_seq_range` and `read_raw_chunk` provide bounded exact readback; unified turn summaries without event offsets use verified raw-turn reconstruction.
- Migration CLI provides audit, plan, apply, resume and verify.
- The panel is read-only current Host state.

## Verified locally

- Real Host fold committed 128 summary blocks: 89 generated and 39 reused.
- Active index and staging matched; raw readback passed.
- Turn-end worker consumed its persistent queue and activated matching summary/vector deltas.
- Production-code replay against the real active index reused existing summaries with zero model and embedding calls.
- Source tests pass; clean-room Host-matrix installation and CLI smoke pass.

## Migration

```text
plan content hash is recomputable from the plan without its hash field
apply requires --plan --approve
apply uses only frozen missing items; reusable items come from the frozen
fullseed-active source
failure preserves the previous active
resume reuses staging; root provider counter is cumulative
verify checks active identity, each base/delta, merged coverage, raw/vector,
cutoff, production query and raw read
```

## Panel

Sections:

```text
current session
记忆共振
unified fold
migration
runtime status and tool catalog
diagnostics
```

No legacy architecture instructions, no provider calls from the panel, and no migration approval implied by opening it.

## Local model prerequisite

The production package does not include Xenova model files. Embedding-enabled features require a user-supplied local model directory and fail before execution when required files are absent. The conversion repository did not provide sufficient redistribution evidence, so the package uses a non-bundled distribution path. See `docs/MODEL.md`.

## Remaining release work

```text
Git source synchronization and CI/release workflow
owner-reviewed publication
```
