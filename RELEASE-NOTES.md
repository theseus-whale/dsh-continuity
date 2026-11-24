# Release notes — 5.0.10

## Ranked semantic neighbors with chronological anchor navigation

- `memory_related` accepts `turnId`, `seq`, `chunkId` or `chunkIndex` anchors and a signed `window` from -20 through -1 or 1 through 20. Positive windows search later chunks; negative windows search earlier chunks; zero is invalid.
- Return up to three `candidates`, sorted by cosine descending and ordinal distance ascending. Preserve `selected` as the strongest candidate with its full summary; other candidate entries contain only coordinates, cosine and ordinal distance, without repeated summaries or raw text.
- Return `nav: { prev, next }` for the resolved anchor alongside semantic candidates. Each direction contains coordinate-only `chunkId`, `turnId`, `chunkIndex`, `seqStart` and `seqEnd`, or `null` at a timeline boundary.
- Chronological `nav` answers what comes immediately before or after; ranked candidates answer what is semantically similar within the chosen window. Neither substitutes for the other. Split chunks sharing one seq remain distinguishable by chunk identity.
- Empty windows return `selected: null` and `candidates: []`. Tool guidance prefers `turnId` or `seq` for ordinary anchoring and reserves `chunkIndex` or `chunkId` for disambiguating split chunks.

## Duplicate active-chunk repair

- Collapse exact physical copies left by overlapping deltas before building the related-chunk timeline. A repeated `chunkId` with conflicting coordinates, summary hash or vector still fails explicitly instead of silently choosing one version.
- Fullseed unified-fold commits skip generated chunks already active with the same summary hash, append only genuinely new chunks, and reject conflicting content before writing or activating a delta.
- Existing indexes are read without mutation. Recall, recall pagination, chronological navigation, summaries, vectors and stored indexes otherwise remain unchanged; no `memory_rebuild` is required.

## 5.0.9 Compact chronological chunk navigation

- Add `prev` and `next` seq ranges to each fullseed HIT, pointing to adjacent readable chunks in the same active index snapshot rather than guessing `seq ± 1`.
- Show only existing directions and no neighbor summaries or raw text; a middle HIT uses one compact line such as `nav: prev 32910-32920 · next 32941-32948`.
- Automatic cue and manual `memory_recall` share the same fullseed rendering. Navigation respects the active cutoff and the caller's historical `beforeSeq` view.
- Add regression coverage for unsorted input, middle/first/last/single chunks, unavailable future chunks and bounded historical views.
- Display-only upgrade: summaries, vectors, chunk identities and stored indexes are unchanged; no `memory_rebuild` is required.

## 5.0.8 Actionable shared recall guidance

- Replace the passive clue warning with concise next-step guidance in both fullseed and legacy ping builders: read by `seq` for verification; use original wording and `beforeSeq` for earlier tracing; no hit does not prove absence.
- Automatic memory cue and manual `memory_recall` share the same note, with no additional footer or mandatory retrieval chain.
- Add regression coverage asserting identical guidance in both ping builders, automatic cue assembly and the manual recall tool response.
- Includes the 5.0.7 `beforeSeq` boundary repair. This display-only upgrade does not change summaries, vectors or indexes; no `memory_rebuild` is required.

## 5.0.7 Historical `beforeSeq` boundary repair

- Separate the active snapshot's availability cutoff from the historical `beforeSeq` content bound. Fullseed summaries keep their activation checkpoint while `beforeSeq` filters only `summary.seqEnd`.
- Fix old summaries disappearing when their fullseed activation checkpoint is later than the requested historical boundary, including ranges whose `seqEnd` is strictly before `beforeSeq`.
- Preserve cursor snapshot stability when `beforeSeq` and pagination are used together. Ordinary recall and automatic quiet cue behavior are unchanged.
- Add regression coverage for `beforeSeq=10500 / 10504 / 12000`, fullseed activation checkpoints and cursor pagination.
- This retrieval-only upgrade does not regenerate raw history, summaries, vectors or indexes; no `memory_rebuild` is required.

## 5.0.6 Shared full-library retrieval

- Add opt-in `retrieval.prototype.enabled` full-library ranking for an active fullseed index. The old top-12 candidate cutoff no longer determines what manual recall can find.
- Manual `memory_recall` keeps bounded pages with v2 cursors, `beforeSeq`, vector-novel deduplication and temporal exploration. Pagination stops when every remaining candidate is below `tau`.
- Quiet automatic cue uses the same full-library ranking, deduplication and temporal exploration while preserving its own `tau`, `delta`, novelty threshold, visible/recent-history suppression, output limits and intent gate. It never receives a pagination cursor.
- The existing configuration key remains `retrieval.prototype` for compatibility; it is opt-in and defaults to `false`. Enable it only for sessions with an active fullseed index; installations that leave it disabled keep the previous retrieval path.
- Raw history, stored summaries and indexes are not regenerated by this package upgrade. No `memory_rebuild` is required solely to upgrade retrieval code.

## 5.0.5

## Visible installation failures

- Persist `turn-ping` installation and rebuild-prerequisite failures to `gate-errors.jsonl`; when pre-step diagnostics are enabled, write the same root cause to `turn-ping-prestep-debug.jsonl` as `install-error`.
- Surface the failure in the panel's recent-error state instead of leaving it only in the Host console.
- When the rebuild service was never registered, `memory_rebuild` now reports the original error code and message, plus the diagnostic location. `probe` cannot succeed before the turn-ping Host and rebuild prerequisites are installed.
- Public defaults, session allowlists, live-injection boundaries and rebuild storage behavior are unchanged.

## 5.0.4

## Scoped Host module resolution

- Resolve the Host panel through `@theseus-whale/dsh-continuity`, the same package used by both preset engines and their tools.
- Keep the Host row id and state route unchanged. This prevents an installed legacy unscoped package from being loaded as a second module instance with stale version and isolated state.
- Add regression coverage for the scoped Host reference and quoted YAML package names.

## Relevant Rule Cue

- Add opt-in `ruleCue` matching for individual `rules.md` and `habits.md` blocks, using the local BGE embedder and the current user input.
- Preserve the existing full-text carrier lifecycle. Turns that inject the full carrier skip the local cue; unrelated input injects nothing.
- Default to `shadow`; `live` additionally requires Host live-injection permission and an explicit `liveSessionIds` allowlist. Other sessions remain unaffected.
- Select all sufficiently relevant, vector-novel blocks rather than imposing a one-rule cap, with a 0.56 confidence gate and recent-history cooldown.
- Keep a live cue across tool follow-up steps, then retire it on the next real user input so cues do not accumulate across turns.
- Record candidate, selection, injection and lifecycle diagnostics for replay. Regression and real Host checks cover injection, no-hit retirement, session isolation and tool-step persistence.

## 5.0.3 Quiet automatic recall

- Add `autoRecall.mode`: `quiet` by default, `off` for no automatic cues, and `legacy` for the previous behavior.
- Quiet mode retrieves only when the current input expresses retrospective intent; raw fallback cannot bypass this gate.
- Deduplicate currently visible and recently injected memories, then select candidates by vector novelty against visible/recent/already-selected vectors.
- Do not impose a one-hit limit; multiple distinct relevant memories can remain. Manual `memory_recall` is unchanged.
- Persist local cue history and decision logs for replay and diagnosis without creating another memory source.
- Regression tests cover intent, switches, fullseed novelty/dedup, pre-step behavior and unchanged manual recall.

## 5.0.2 Host-only full rebuild

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
