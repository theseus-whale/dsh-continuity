# Install and operate 5.0.2

## Requirements

- DSH desktop with the declared Host peer packages.
- Node.js >=22 for package installation and validation.
- An absolute local BGE model directory for embedding-enabled features; model files are not bundled.

## Back up and install

1. Back up the DSH profile and `~/.dsh/continuity`.
2. Install the reviewed package without forcing peer dependencies:

```text
npm install <path-to-theseus-whale-dsh-continuity-5.0.2.tgz> --ignore-scripts --no-audit --no-fund
```

3. Point the Host bundle and scoped client module to `@theseus-whale/dsh-continuity`.
4. Cold-start DSH and verify `plugin.version = 5.0.2`, the panel Slot, and `memory_recall` / `memory_rebuild` in the tool catalog.

There is no `dsh-continuity` command to run. The package has no Node CLI, separate API-key prompt, external provider module or independent DeepSeek transport.

## Local enablement

Public defaults remain off. Create an unpublished overlay only for the intended sessions:

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
  "sessionIds": ["<local-session-id>"],
  "fullseedEnqueue": true,
  "fullseedWorker": true
}
```

`Index-only` keeps retrieval/index work separate from natural injection. `Live natural cue` additionally requires the reviewed live boundary. Installing a package or setting model names does **not** enable Host memory resonance or live injection.

All summary generation uses Host `ctx.llm`. Existing provider credentials remain in DSH's own configuration; no credential is read from this plugin's overlay.

## Rebuild the current session

Both Continuity presets expose:

```text
memory_rebuild({ action: "probe" })
memory_rebuild({ action: "start" })
memory_rebuild({ action: "status", jobId? })
memory_rebuild({ action: "cancel", jobId? })
memory_rebuild({ action: "resume", jobId? })
```

Recommended order:

1. Run `probe` once. It performs one Host model call and writes no job or index.
2. Only after a non-empty, structurally valid `complete`, call `start` once.
3. Use `status` to inspect the same session's persistent job; do not repeat `start` while it is active.
4. The Host pauses that session's incremental worker, writes shadow summaries/vectors, catches up to the latest checkpoint, verifies complete coverage, then atomically activates the new base.
5. `cancel` stops further work without activating a partial result. After a Host restart, `resume` continues the recorded job explicitly.

Rebuild is strictly scoped to the calling `exec.agent.session.id`. The calling LLM does not write summaries and no subagent or additional conversation is created.

## Vector-L and recall

Generation requests one line, one Chinese sentence, about 100 characters and at most 256 characters, with semicolons allowed. Ingestion remains soft: overlong, multiline and multi-sentence outputs are recorded with warnings rather than rejected or retried. Resonance display is not truncated.

`memory_recall({ query })` uses the same semantic resonance path as automatic memory cue. It returns pointers for exact readback; a summary is a clue, not the original evidence.

## Disable and rollback

```text
remove or rename the local overlay and cold-start to restore public default-off behavior
restore the previous profile/package backup for a code rollback
keep raw history and old bases; do not delete them during a package upgrade
```

A failed or cancelled rebuild preserves the previous live index. A successful package installation does not itself regenerate historical summaries.
