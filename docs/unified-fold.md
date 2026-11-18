# Unified fold and turn-end archival

Both features are opt-in and use explicit per-session allowlists. Public defaults are off.

## Turn-end archival

`agent/turn-stopping` writes a stable queue ID for a completed Host turn. The background worker, when explicitly enabled, generates the summary and vector, writes a delta and activates it atomically. Duplicate events do not duplicate queue entries, and a covered checkpoint is settled without another model call.

The worker and unified fold share Host `turn/start` / `turn/end` grouping. Legacy sessions without those markers retain the user/peer-delimited fallback. Open turns are not archived as completed turns.

## Fold-time reuse

Unified fold maps the selected **positional surface slice** to raw turns. Newer checkpoints and memory projections can occur inside that slice; they are cleaned as projections rather than rejected by numeric seq ordering.

A closed turn whose remaining raw surface is only partly selected can still be summarized from its complete raw log. Open partial turns remain protected. The inherited Host transaction owns `compaction/start`, `compaction/summary`, checkpoint replacement and `compaction/end`.

Existing summaries are reused only with exact evidence:

- one unified summary matching the full turn and raw hash; or
- fullseed chunks whose hashes and event offsets collectively cover every raw content event in the turn.

Long-turn chunks therefore remain reusable. Missing or stale coverage falls back to fold-time generation. Staging is under `turn-ping/fold-staging/`; failures do not activate a replacement index.

## Exact readback

`read_seq_range` reads bounded raw text by seq. `read_raw_chunk` reads fullseed chunks by event offsets. For unified summaries without offsets, it reconstructs the complete raw turn and verifies the trimmed/newline raw identity before returning text.

Local overlay example:

```yaml
unifiedFold:
  enabled: true
  sessionIds:
    - session-<local>
  providerId: deepseek-official
  model: deepseek-flash
  embeddingModel: <absolute-local-model-directory>
  credentials: <local-credentials-yaml>
```

Credentials and real session IDs belong only in unpublished local configuration.
