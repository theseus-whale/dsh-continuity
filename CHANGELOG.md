# Changelog

## 4.9.109

- Normalize JSON `null` audit state
- Add a cross-process `audit.lock` with stale/future-mtime recovery
- Require strict base64 before vector decoding
- Update remaining legacy gate selectors to accept both prefixes

## 4.9.108

- Recover stale `running:true` audit state after a 15-minute TTL
- Validate vector payloads (base64, finite, non-zero, consistent dimensions)
- Accept the legacy gate prefix alongside the neutral peer/gate prefix

## 4.9.107

- Audit k is capped by the number of vector-bearing records
- Added coverage for sparse 1, 5, and 19 record indexes

## 4.9.106

- Removed personal validation probes from `bin/bc-relabel.mjs`
- Replaced historical dates, turn counts, and seq ranges in comments with
  generic descriptions
- Cleaned personal names and prefixes from `event-alias-ledger.mjs`, `t0.mjs`,
  `threads-core.mjs`, and source comments

## 4.9.105

- Empty K fallback is now empty; no personal/default names
- README, architecture, and templates use neutral examples
- Removed a personal example phrase and emoji from the public source

## 4.9.104

- `dropped-ranges.json` is per session: `sessions/<id>/dropped-ranges.json`
- Global dropped-ranges is no longer written; seq spaces from different sessions
  must not be merged
- Startup rebuild and per-pass rebuild are session-scoped

## 4.9.103

First public-source cleanup.

- Chinese README, guides 00–05, SESSION-LAYOUT, RELEASE-NOTES
- Removed personal paths, session IDs, internal project names, and experimental scripts from the public tree
- Added MIT LICENSE, DISCLAIMER, PRIVACY, SECURITY, THIRD-PARTY-NOTICES
- Package includes only runtime `bin/bc-relabel.mjs` and `bin/export-turns.py`
- Kept session-local A/B/C/K/rules/habits and best-effort guard

## 4.9.102

- Chinese main documentation
- Rebuild guide validation status clarified

## 4.9.101 and earlier

Private development history. See the upstream repository's release notes.
