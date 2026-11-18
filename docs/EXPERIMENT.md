# Offline migration experiment

This is a current operational test, not a live provider trial.

## Fixture path (outside the public package)

```text
analysis/migration-fixture/
```

The candidate package never includes the fixture, its real session ID, or the
offline adapter.

## Offline adapter

```text
createProvider() -> { provider, embedder }
```

Provider returns approved summaries by chunk ID; embedder returns approved
vectors by summary SHA. Unknown/mismatched inputs throw.

## Commands

```text
dsh-continuity migrate plan --session <id>
dsh-continuity migrate apply --plan <plan> --approve --provider-module <adapter>
dsh-continuity migrate verify --plan <plan> --query <text> --embedder-module <adapter>
dsh-continuity migrate resume --plan <plan> --approve --provider-module <adapter>
```

## Expected checks

```text
full:    apply pending0; verify chunks157; query/raw-read pass
partial: reusable40 / missing117; 40 reuse with zero calls; 117 calls; total157
failure: previous active unchanged; resume completes
verify:  active identity; base/delta artifacts; merged coverage; raw/vector/cutoff
```

## Cost boundary

No real provider is called by the offline adapter. A real apply would call the
configured summary provider only for frozen missing items; embeddings are local
BGE. Provider calls are capped by the plan budget and the root counter.

## Release material

Model files are not bundled in the production package. A user-supplied local
Xenova model directory is required for embedding-enabled features; see `MODEL.md`.
