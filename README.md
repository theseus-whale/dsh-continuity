# @theseus-whale/dsh-continuity 5.0.0

Current architecture release candidate. Public defaults are **off**; local overlays explicitly enable memory resonance, turn-end archival and unified fold for allowlisted sessions.

## Current capabilities

```text
memory resonance    Host-turn summaries/vectors for allowlisted sessions
turn-end archival   stable queue + background worker + atomic summary/vector deltas
raw write index     immediate lexical pointers from canonical events; no fold/model needed
unified fold        exact-evidence summary reuse with fold-time fallback for missing coverage
exact readback      bounded seq reads and verified raw-chunk/raw-turn reads
migration           audit / plan / apply / resume / verify
panel               waterlines, model window, runtime status, and Host-reported tool catalog
```

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

Missing local overlay means disabled. A malformed overlay is an error. The worker flags `fullseedEnqueue` and `fullseedWorker` also default off publicly. A migration plan is not an approval.

## Requirements and verified Host

```text
Node.js >=22
DSH host supplies the peer packages
```

Verified against the installed DSH desktop runtime `0.2.2-rc.3`, Cordis `4.1.0`, and Host peer packages `0.2.2-rc.3`. The package declares measured peer ranges; this is a tested baseline, not a claim of support for every future Host.

## Install

```text
npm install <path-to-dsh-continuity-5.0.0-<hash>.tgz>
```

For an existing installation, audit and plan before apply:

```text
dsh-continuity migrate audit
dsh-continuity migrate plan --session <id>
dsh-continuity migrate apply --plan <plan.json> --approve --provider-module <file>
dsh-continuity migrate resume --plan <plan.json> --approve --provider-module <file>
dsh-continuity migrate verify --plan <plan.json> --query <text> --embedder-module <file>
```

See [INSTALL.md](INSTALL.md) for backup, rollback and the complete review order.

## Turn-end archival and fold reuse

When explicitly enabled, `agent/turn-stopping` records a completed Host turn with a stable queue ID. The background worker generates its summary and vector, then writes and activates an atomic delta. Duplicate events and already-covered checkpoints do not repeat model work.

Unified fold reuses a complete unified summary or a complete set of raw-evidence chunks. It does not reuse a partial summary merely because its `turnId` matches. Missing or stale coverage is still generated at fold time, and open turns remain protected.

This spreads model latency across normal turns instead of concentrating it in one fold. Per-turn summaries generally consume more total output tokens than one global summary; the benefit is incremental archival and fold-time reuse, not token minimization.

## Data and cost boundary

```text
raw write index           local derived full-text/pointer cache; no model call
local BGE embedding       local model; no text leaves the machine for embedding
turn-end summary worker   explicit opt-in; sends completed-turn text to the configured provider
unified fold              reuses exact coverage; generates only missing/stale turns
migration apply           provider calls only for frozen missing items
panel                     read-only; never calls provider
```

Provider credentials belong in local environment/overlay only. The public package contains no credentials, real session IDs, user-home paths or private overlays. Explicit direct-provider configuration is documented in [docs/PORTABILITY.md](docs/PORTABILITY.md).

## Local overlay

```text
~/.dsh/continuity/local/memory-resonance.json
~/.dsh/continuity/local/unified-fold.json
```

These are never published. See [INSTALL.md](INSTALL.md), [docs/PORTABILITY.md](docs/PORTABILITY.md), and [docs/unified-fold.md](docs/unified-fold.md).

## Panel

The panel preserves the waterline bar and model-window projection, then adds observed runtime status and a Host-reported tool catalog with usage notes. Session-local fold history is not shown in this global panel. The panel never writes indexes or raw records. See [PANEL.md](PANEL.md).

## Package contents

The production package excludes tests, historical guides/archives, source backup files and model weights. Historical material is not part of current installation or compatibility claims.

## Model and project license

The project license is in `LICENSE`. The Xenova model is a required local prerequisite for embedding-enabled features, but its files are not bundled. Set `embeddingModel` to an absolute user-supplied directory; missing files fail before model execution. See [docs/MODEL.md](docs/MODEL.md) for the distribution decision and verified artifact identity.
