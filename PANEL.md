# Continuity panel

The panel is read-only and reads `/dsh-continuity/state.json` from the Host.
It does not write indexes or raw records, call a provider, or approve a migration.

## Preserved working sections

### Compaction waterlines

The existing waterline bar and policy values remain: setpoint, high, low,
emergency, protect, maximum per pass, and minimum action. Values come from the
mounted engine policy.

### Current model window

The projection uses the active model route and current compaction policy. It is
a diagnostic projection, not a claim that a fold occurred.

### Runtime status

Shows the resolved model route, the configured BGE model and existing vector
count, write-time index record/reconcile counts, authorized session count, and
recent errors. Model metadata resolution is not presented as a successful model
call; existing vectors are not presented as a fresh embedding probe.

### Tool catalog

Always lists the tools provided by this package, with Chinese usage notes and
parameter guidance. Host schemas only add current session visibility. When no
live schema is observed, the static catalog remains visible and visibility is
marked "not observed"; the catalog never disappears for lack of observation.

## Session-local history stays out of the global panel

Fold records belong to their individual sessions. The global plugin panel does
not show a cross-session "recent folds" card or imply that sessions share a fold
history.

## Removed obsolete UI

The old A/B/C/K cards, right-sidebar registrations, old instructional copy, and
historical runtime-version notes are not part of this panel. Removing those
obsolete sections must not remove the waterline or projection.

The client requires only `slots` and `locale`; it does not wait for obsolete
right-sidebar services before mounting the main panel.

## Errors and refresh

Host route failures show the actual error and a reload action. Refreshing the
panel never starts a provider, migration, index write, or raw-record write.
