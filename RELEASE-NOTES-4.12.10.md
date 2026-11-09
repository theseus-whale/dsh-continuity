# 4.12.10

Audit and review changes only.

## Recent audit candidate

`runAudit` adds one explicit recent candidate from the last 40 rows, in
addition to the global kmeans clusters. It records `emptyRate`, `bleed` /
`bleedRate`, and `newTermRate`. Audit state stores `conceptsAtLastAudit`; the
first run after upgrading does not treat every existing concept as new.

## Per-turn recent gate

A cheap pre-step gate checks the last 24 `bc-index` rows, without kmeans or
embeddings. It injects a short, one-shot review directive when `emptyRate >=
0.30` or two or more turns are grabbed by a newly added concept. The same
session is reviewed at most once per 12 turns. It is part of the same turn's
pre-step, not a separate turn.

## Known limitation

The per-turn gate still uses the legacy `confidence` / `conceptScores` empty
signal. Topic-based empty rate is usually much higher and must be calibrated
before it can gate reviews.
