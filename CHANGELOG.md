# Changelog

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
