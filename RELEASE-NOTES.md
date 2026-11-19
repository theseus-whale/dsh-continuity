# Release notes — 5.0.2

## Host-only full rebuild

- Add `memory_rebuild({ action: 'probe' | 'start' | 'status' | 'cancel' | 'resume', jobId? })` to both Continuity presets.
- The calling LLM only submits or controls a job; DSH Host writes summaries through configured `ctx.llm` and local BGE.
- Remove the fullseed and migration Node CLIs, independent DeepSeek transports, external provider module boundary and plugin-specific API-key path.
- No CLI process, separate API-key input, subagent or additional conversation session is used.
- Jobs start at the first eligible raw turn, checkpoint shadow progress, catch up to the latest session checkpoint, and activate only complete verified coverage.
- Incremental work for the affected session pauses during rebuild; cancellation preserves the previous live index.
- Final progress counts follow the activated snapshot rather than stale staging entries.

## Vector-L summary contract

- Prompts request one line, one Chinese sentence, a target of about 100 characters and a maximum of 256 characters, with semicolons allowed.
- Summary requests explicitly use `reasoningEffort: 'off'`; task instructions are separated from historical raw material so the model summarizes rather than answers it.
- Soft ingestion is unchanged: overlong, multiline and multi-sentence outputs remain accepted with warnings and are not retried or rejected.
- Resonance rendering is unchanged; this release does not truncate or disguise historical long summaries.
- Existing raw history and stored summaries are preserved. Regeneration is an explicit per-session rebuild operation.

## Real Host verification

- A real Continuity session completed Host rebuild and activated a new verified base with 3951 summaries and 3951 vectors.
- Independent multi-frame raw replay verified every chunk ID, raw-text/raw-record hash, seq range and vector record at the activated checkpoint.
- A second allowlisted session retained an unchanged active hash throughout the rebuild.
- Related regression tests cover Host prompts, non-reasoning requests, soft ingestion, authorization, cancellation, session isolation, activation and final counters.

## 5.0.1 active semantic recall

- Add `memory_recall({ query })` to both Continuity presets, using the same memory-resonance path as automatic memory cue.
- Respect current-session enablement and cutoff; report disabled and no-hit states without fabricating memories.
- Exclude derived recall tool results from future summary source views and raw fallback indexing.
- Include `memory_recall` in the panel tool catalog with its purpose and `query` parameter notes.
- No BM25, RRF, exact-search substitution, or second retrieval index.

## Scoped UI repair

- Keep panel state routing stable for scoped and unscoped package names.
- Quote scoped `name` scalars in `cordis.patch.yml` and register the client factory as `@theseus-whale/dsh-continuity`.
- Treat unavailable optional Host locale/slot injections as diagnostics rather than failing current state.

## Local model prerequisite

The production package does not include Xenova model files. Embedding-enabled features require a user-supplied local model directory and fail before execution when required files are absent. See `docs/MODEL.md`.
