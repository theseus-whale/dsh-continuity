# Install — dsh-continuity 5.0.0

## Before install

```text
back up profile and ~/.dsh/continuity
keep the public package default-off until a local overlay is reviewed
do not commit credentials or local session IDs
```

## Required local model

Embedding-enabled features require a user-supplied local copy of
`Xenova/bge-small-zh-v1.5`; model files are not bundled. Obtain and review the
model before enabling memory features, then set every enabled overlay's
`embeddingModel` to its absolute directory. It must contain `config.json`,
`tokenizer.json`, `tokenizer_config.json` and `onnx/model_quantized.onnx`.
Missing files are an explicit error. See `docs/MODEL.md`.

## Package

```text
npm pack
# install the resulting dsh-continuity-5.0.0-<hash>.tgz through the normal DSH flow
```

Do not install from a legacy guide or replace a live profile by hand.

## Public defaults

```yaml
turnPing:
  enabled: false
  mode: shadow
  localConfig: ./local/memory-resonance.json

unifiedFold:
  enabled: false
  localConfig: ./local/unified-fold.json
```

## Enable memory resonance locally

```text
mkdir -p ~/.dsh/continuity/local
```

### Index-only (no natural cue)

This creates summaries/vectors but keeps live injection off:

```json
{
  "enabled": true,
  "mode": "shadow",
  "sessionIds": ["<session-id>"],
  "boundaries": { "allowLiveInjection": false },
  "provider": "<provider>",
  "model": "<model>",
  "embeddingModel": "<absolute-local-model-directory>"
}
```

The panel should show memory enabled for the session, with retrieval/readiness
observed only when the active index exists. No natural cue is injected while
`allowLiveInjection` is false.

### Live natural cue (complete minimal example)

Public patch defaults `allowLiveInjection` to false. To actually inject a
natural cue, the overlay must opt in explicitly:

```json
{
  "enabled": true,
  "mode": "opt-in",
  "sessionIds": ["<session-id>"],
  "boundaries": { "allowLiveInjection": true },
  "provider": "<provider>",
  "model": "<model>",
  "embeddingModel": "<absolute-local-model-directory>"
}
```

An empty or missing `sessionIds` is an error, not all-session injection. The
two examples are not interchangeable: the first builds an index, the second
permits live cues.

## Enable unified fold locally

Create `unified-fold.json`:

```json
{
  "enabled": true,
  "sessionIds": ["<session-id>"],
  "providerId": "<provider>",
  "model": "<model>",
  "embeddingModel": "<absolute-local-model-directory>"
}
```

An empty `sessionIds` is deny-all; omitted IDs are an error.

## Host-provided peer packages

DSH supplies the host packages. The public package declares measured peer ranges
and marks them optional so npm does not pull a mismatched host tree:

```text
@deepseek-ai/cordis                 >=4.1.0 <5
@deepseek-ai/dsh-agent              >=0.2.2-rc.3 <0.3.0
@deepseek-ai/dsh-compaction         >=0.2.2-rc.3 <0.3.0
@deepseek-ai/dsh-compaction-basic   >=0.2.2-rc.3 <0.3.0
@deepseek-ai/dsh-llm                >=0.2.2-rc.3 <0.3.0
@deepseek-ai/dsh-session            >=0.2.2-rc.3 <0.3.0
@deepseek-ai/dsh-token-meter        >=0.2.2-rc.3 <0.3.0
@deepseek-ai/dsh-tools              >=0.2.2-rc.3 <0.3.0
```

Clean-room install command (do not use `--force` or `--legacy-peer-deps`):

```text
npm install <path-to-dsh-continuity-5.0.0-<hash>.tgz> --ignore-scripts --no-audit --no-fund
```

A clean-room `npm install --package-lock-only` with this package succeeds. The
host packages remain provided by the running DSH host.

## Turn-end archival worker

To archive completed Host turns before folding, enable both worker flags in the
**memory-resonance** overlay:

```json
{
  "fullseedEnqueue": true,
  "fullseedWorker": true
}
```

These combine with `enabled`, the session allowlist and the provider settings in
the examples above. The queue is persistent and deduplicated. The worker runs
in the background; unified fold still generates any missing or stale coverage.

## Credentials: distinct CLI, Host and direct paths

These configuration boundaries are **not** interchangeable:

```text
CLI provider module / migration / repair:
  DSH_CONTINUITY_CREDENTIALS
  DSH_CONTINUITY_ENDPOINT
  DSH_CONTINUITY_PROVIDER
  DSH_CONTINUITY_MODEL
  used by the CLI provider-module boundary

Host summary provider (default):
  ctx.llm + overlay provider/model
  createLlmSummaryProvider runs inside DSH

Optional direct DeepSeek stream for unified fold and turn-end worker:
  credentials in the corresponding private overlay, or DSH_CONTINUITY_CREDENTIALS
  endpoint may be set explicitly when needed
```

The direct path preserves HTTP/provider errors without relying on the Host's
normalized `TRANSPORT` failure. Credentials are never included in the public
package. Setting environment variables does **not** enable Host memory resonance
or the worker; Host enablement still requires the reviewed overlay, allowlist and
boundaries.

## Upgrade / migration flow

This is the complete order for an existing user. Defaults stay off throughout
until the explicit steps.

```text
1. Back up the profile and ~/.dsh/continuity.
2. Install the package with public defaults still off.
3. Audit and plan; this is read-only and calls no summary provider.
     dsh-continuity migrate audit --session <id>
     dsh-continuity migrate plan --session <id>
4. Review the frozen plan. A plan is NOT approval.
5. Apply explicitly; only this step may incur summary-provider cost.
     dsh-continuity migrate apply --plan <plan> --approve \
       --provider-module <module>
6. If apply fails or is interrupted, resume the same plan explicitly:
     dsh-continuity migrate resume --plan <plan> --approve \
       --provider-module <module>
   The previous active is preserved until activation succeeds.
7. Verify the result:
     dsh-continuity migrate verify --plan <plan> --query <text> \
       --embedder-module <module>
8. Only after the migration is reviewed, configure the local overlay and
   restart DSH. The panel never performs migration or approval.
```

## Rollback

```text
remove or rename the relevant local overlay
restart DSH
restore the profile/package backup if needed
```

Old active indexes and raw records are not rewritten by the panel.

## Historical guides

Historical guides, archives and source backup files are excluded from the
production package. Do not use old copies as current install steps.
