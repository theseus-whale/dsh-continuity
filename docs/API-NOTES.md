# API notes — 5.0.2

## Web routes

```text
GET /dsh-continuity/current.json
GET /dsh-continuity/state.json        diagnostic state
GET /dsh-continuity/bc.json           legacy, not used by panel
GET /dsh-continuity/facets.json       legacy, not used by panel
```

The current panel uses `/dsh-continuity/state.json`; routes are read-only and never start provider work.

## Host tools

```text
memory_recall({ query })
memory_rebuild({ action: "probe" })
memory_rebuild({ action: "start" })
memory_rebuild({ action: "status", jobId? })
memory_rebuild({ action: "cancel", jobId? })
memory_rebuild({ action: "resume", jobId? })
read_seq_range({ fromSeq, toSeq, maxBytes? })
read_raw_chunk({ chunkId, byteOffset?, maxBytes? })
```

`memory_rebuild` is scoped to the calling session and delegates all summary generation to Host `ctx.llm`. `probe` writes nothing. `start` creates one shadow job; complete catch-up coverage is required before live activation. There is no Node CLI or external provider module boundary.

## Host state fields

```text
plugin.version / packageHash
session.id / preset / engineMounted / lastError
memoryResonance.enabled / summaries / vectors / checkpoint / availableCutoff
memoryResonance.latestCue / retrieval / rawRead
unifiedFold.enabled / sessionAllowed / lastFold / reinjection / pending
diagnostics.version / packageHash / node / hostServices / errors
```

These are diagnostics, not policy claims. The panel does not expose migration approval or provider actions.
