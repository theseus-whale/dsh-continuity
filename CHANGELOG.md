# Changelog

## 5.0.3

- Add quiet/off/legacy automatic-recall modes, defaulting to quiet
- Gate automatic retrieval on retrospective intent and prevent raw fallback from bypassing it
- Deduplicate visible/recent cues and select dynamically by vector novelty rather than a fixed one-hit rule
- Keep manual `memory_recall` unchanged and record local cue decisions/history for replay
- Add regression tests for quiet intent, switches, fullseed novelty, history expiry and pre-step gating

## 5.0.2

- Require Vector-L turn-summary prompts to request one line, one Chinese sentence, a 100-character target and a 256-character limit
- Add `memory_rebuild({ action })` so the Host—not the calling LLM—runs full rebuilds through `ctx.llm` with start/status/cancel/resume controls
- Pause per-session incremental workers during Host rebuilds, catch up to the latest checkpoint, and atomically activate verified complete coverage
- Preserve soft ingestion: overlong, multiline and multi-sentence model results are still recorded with warnings rather than rejected or retried
- Keep resonance rendering unchanged; historical noncompliant long summaries require explicit regeneration, not display truncation
- Add regression coverage for Host prompts, soft ingestion, rebuild authorization, cancellation and activation
- Remove fullseed/migration Node CLIs, independent DeepSeek transports and plugin-specific credential paths; all summary calls use Host `ctx.llm`
- Separate summary instructions from historical material and explicitly disable reasoning for summary requests
- Report final rebuild progress from the activated snapshot rather than stale staging entries

## 5.0.1

- Add `memory_recall({ query })` to both Continuity presets using the existing memory-resonance retrieval path
- Exclude derived recall tool results from future summary source views and raw fallback indexing
- Fix scoped panel routing, Host diagnostic access without `locale`/`slots`, YAML scoped names, and client factory registration
- Show `memory_recall` and its query parameter in the panel tool catalog

## 4.9.110

- `audit.lock` carries an owner token; release only deletes its own lock
- Stale locks are renamed to a quarantine path and token-checked before removal
- Audit eligibility is rechecked after lock acquisition

## 4.9.109

- Normalize JSON `null` audit state
- Add a cross-process `audit.lock` with stale/future-mtime recovery
- Require strict base64 before vector decoding
- Update remaining legacy gate selectors to accept both prefixes

## 4.9.108

- Recover stale `running:true` audit state after a 15-minute TTL
- Validate vector payloads (base64, finite, non-zero, consistent dimensions)
- Accept the legacy gate prefix alongside the neutral peer/gate prefix

## 4.9.107

- Audit k is capped by the number of vector-bearing records
- Added coverage for sparse 1, 5, and 19 record indexes

## 4.9.106

- Removed personal validation probes from `bin/bc-relabel.mjs`
- Replaced historical dates, turn counts, and seq ranges in comments with
  generic descriptions
- Cleaned personal names and prefixes from `event-alias-ledger.mjs`, `t0.mjs`,
  `threads-core.mjs`, and source comments

## 4.9.105

- Empty K fallback is now empty; no personal/default names
- README, architecture, and templates use neutral examples
- Removed a personal example phrase and emoji from the public source

## 4.9.104

- `dropped-ranges.json` is per session: `sessions/<id>/dropped-ranges.json`
- Global dropped-ranges is no longer written; seq spaces from different sessions
  must not be merged
- Startup rebuild and per-pass rebuild are session-scoped

## 4.9.103

First public-source cleanup.

- Chinese README, guides 00–05, SESSION-LAYOUT, RELEASE-NOTES
- Removed personal paths, session IDs, internal project names, and experimental scripts from the public tree
- Added MIT LICENSE, DISCLAIMER, PRIVACY, SECURITY, THIRD-PARTY-NOTICES
- Package includes only runtime `bin/bc-relabel.mjs` and `bin/export-turns.py`
- Kept session-local A/B/C/K/rules/habits and best-effort guard

## 4.9.102

- Chinese main documentation
- Rebuild guide validation status clarified

## 4.9.101 and earlier

Private development history. See the upstream repository's release notes.
