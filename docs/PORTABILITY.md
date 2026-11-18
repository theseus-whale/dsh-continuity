# Local-only configuration overlay

The published package contains no user session IDs, credential paths or private overlays. Local installs use unpublished files under the continuity home:

```text
~/.dsh/continuity/local/memory-resonance.json
~/.dsh/continuity/local/unified-fold.json
```

They are intentionally separate:

- `memory-resonance.json` controls retrieval, turn-end archival and natural injection.
- `unified-fold.json` controls the unified fold path.

The public preset only contains:

```yaml
turnPing:
  enabled: false
  mode: shadow
  localConfig: ./local/memory-resonance.json

unifiedFold:
  enabled: false
  localConfig: ./local/unified-fold.json
```

## Memory resonance and turn-end worker

Local-only example; never publish real IDs or paths:

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
  "fullseedWorker": true,
  "credentials": "<local-credentials-yaml>"
}
```

`fullseedEnqueue` records completed turns with stable queue IDs. `fullseedWorker` consumes the queue in the background. Both default off publicly. If `credentials` is omitted, the worker can use the Host `ctx.llm` path; when supplied, it uses the explicit DeepSeek direct stream.

## Unified fold

Local-only example:

```json
{
  "enabled": true,
  "sessionIds": ["<local-session-a>", "<local-session-b>"],
  "providerId": "deepseek-official",
  "model": "deepseek-flash",
  "embeddingModel": "<absolute-local-model-directory>",
  "credentials": "<local-credentials-yaml>"
}
```

The same local credentials file may be referenced by both overlays. It is never included in the package. Missing direct credentials leave the Host route in use; the CLI provider boundary still fails closed when its required credentials are absent.

## Disable and recover

```text
remove or rename the relevant local overlay file
restart -> public default disabled again
change only the local file; never edit the public package
restore the previous profile/package backup for a code rollback
raw logs and old active are never rewritten by this switch
```

Provider routing for CLI fullseed/repair is explicit, not from a hardcoded user path:

```text
DSH_CONTINUITY_CREDENTIALS=<path to credentials yaml>
DSH_CONTINUITY_ENDPOINT=https://api.deepseek.com/anthropic/v1/messages
DSH_CONTINUITY_PROVIDER=deepseek-official
DSH_CONTINUITY_MODEL=deepseek-flash
```

Missing Host overlay -> disabled. Malformed overlay -> error. Enabled overlay with omitted or empty `sessionIds` -> error; it never becomes all-session injection. `local/` is intentionally absent from the npm package.
