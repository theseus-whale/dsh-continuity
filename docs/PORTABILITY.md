# Local-only configuration overlay

The published package contains no user session IDs, credential paths or private overlays. Local installs use unpublished files under the continuity home:

```text
~/.dsh/continuity/local/memory-resonance.json
~/.dsh/continuity/local/unified-fold.json
```

They are intentionally separate:

- `memory-resonance.json` controls retrieval, turn-end archival, `memory_recall`, `memory_rebuild` and natural injection.
- `unified-fold.json` controls the unified fold path.

## Memory resonance and Host rebuild

Local-only example; never publish real IDs or model directories:

```json
{
  "enabled": true,
  "mode": "opt-in",
  "boundaries": {
    "allowDefaultEnable": true,
    "allowLiveInjection": true
  },
  "provider": "deepseek-official",
  "model": "deepseek-flash",
  "embeddingModel": "<absolute-local-model-directory>",
  "sessionIds": ["<local-session-a>", "<local-session-b>"],
  "fullseedEnqueue": true,
  "fullseedWorker": true
}
```

`fullseedEnqueue` records completed turns with stable queue IDs. `fullseedWorker` consumes the queue in the background. Both default off publicly. `memory_rebuild` uses the same Host `ctx.llm` and local embedder, with strict per-session authorization.

No `credentials`, endpoint or direct-provider flag is read. Provider authentication belongs to DSH itself and is never duplicated by this package.

## Unified fold

```json
{
  "enabled": true,
  "sessionIds": ["<local-session-a>", "<local-session-b>"],
  "providerId": "deepseek-official",
  "model": "deepseek-flash",
  "embeddingModel": "<absolute-local-model-directory>"
}
```

Unified fold also uses Host `ctx.llm`; there is no alternate direct transport.

## Disable and recover

```text
remove or rename the relevant local overlay file
restart -> public default disabled again
change only the local file; never edit the public package
restore the previous profile/package backup for a code rollback
raw logs and old active bases are never rewritten by this switch
```

Missing Host overlay -> disabled. Malformed overlay -> error. Enabled overlay with omitted or empty `sessionIds` -> error; it never becomes all-session injection. `local/` is intentionally absent from the npm package.
