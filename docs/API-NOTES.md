# API notes — current 5.0.0

## Web routes

```text
GET /dsh-continuity/current.json
GET /dsh-continuity/state.json        old diagnostic shape, not used by panel
GET /dsh-continuity/bc.json           legacy, not used by panel
GET /dsh-continuity/facets.json       legacy, not used by panel
```

The current panel must use `/dsh-continuity/current.json`. It is read-only.

## CLI

```text
dsh-continuity migrate audit [--session <id>] [--dsh-home <dir>]
dsh-continuity migrate plan --session <id> [--out <file>]
dsh-continuity migrate apply --plan <file> --approve --provider-module <file>
dsh-continuity migrate resume --plan <file> --approve --provider-module <file>
dsh-continuity migrate verify --plan <file> --query <text> --embedder-module <file>
```

`apply`/`resume` require explicit approval. `verify` can use an offline
embedder module and does not call a summary provider.

## Host state fields

```text
plugin.version / packageHash
session.id / preset / engineMounted / lastError
memoryResonance.enabled / summaries / vectors / checkpoint / availableCutoff
memoryResonance.latestCue / retrieval / rawRead
unifiedFold.enabled / sessionAllowed / lastFold / reinjection / pending
migration.plan / audit / reusable / missing / budget / resume / verify
migration.legacyActivePreserved
diagnostics.version / packageHash / node / hostServices / errors
```

These are diagnostics, not policy claims.

## Removed from current UI/docs

The panel does not use the old tag table, config projection, rc-specific facts,
or legacy try-it guidance. Historical files are archived.
