# Continuity architecture — 4.11.12

## 1. Shape

```text
DSH Host
  └ dsh-continuity host row
       ├ /dsh-continuity/state.json
       ├ /dsh-continuity/bc.json
       ├ /dsh-continuity/peer
       ├ per-session bc pre-step
       └ best-effort tool path guard

Continuity preset
  ├ compaction engine
  ├ session_log
  └ threads-tool (safe mode: recall + peer + session_log)

Client
  ├ left sidebar control panel
  └ per-session A/B/C/K right tab
```

Safe mode does not add a separate prompt-classification, tagging, or workline layer.

## 2. Session owns everything

```text
~/.dsh/continuity/sessions/<sessionId>/
  bc-index.jsonl
  bc-index-state.json
  audit-state.json
  expand-hint.jsonl
  concepts.md
  cmap.md
  keywords.md
  aliases.md
  rules.md
  habits.md
  rebuild.md
```

No A/C/K/rules/habits inheritance between sessions. A new session starts with:

```text
empty A/C/K
rules.md   <- templates/rules.md
habits.md  <- templates/habits.md
```

Personas are identity/enable labels only:

```text
session-persona.json:
  <sessionId> -> continuity | <pid>
  default -> continuity

personas/<pid>/persona.json:
  {"enabled": true}
```

`continuity` is enabled for old installs without a file. A disabled persona is
skipped by the pre-step and its panel returns `persona-disabled`.

## 3. Write path

```text
completed human turn
-> bc-pre-step sees agent.session.id
-> resolve persona (enable check only)
-> ensure session scaffolds
-> index file sessions/<id>/bc-index.jsonl
-> read session tail after lastSeq
-> label with that session's concepts
-> append one pointer record
-> save JSONL + bc-index-state.json
```

The current turn is indexed on the next pre-step. Up to 8 missing turns per
pass; background repair continues. Failure writes `gate-errors.jsonl`.

New records carry:

```json
{
  "turn": 40,
  "seqStart": 2186,
  "seqEnd": 2186,
  "generic": ["跑团叙事", "原文与上下文"],
  "genericTopic": ["跑团叙事"],
  "genericWorkflow": ["原文与上下文"],
  "topicScore": 0.71,
  "topicConfidence": "normal",
  "labelVersion": 2,
  "terms": ["跑团"],
  "keywords": ["coo"],
  "conceptScores": {"跑团叙事": 0.71, "原文与上下文": 0.66},
  "vec": "...",
  "chatter": 0.42,
  "sessionId": "session-..."
}
```

No raw text is stored in the index. Old records read as `labelVersion: 1` and
have no `topicScore`; they are not backfilled.

## 4. A / B / C / K

### A — concepts

```text
name | description words | coverage estimate | kind
kind = topic | workflow   (default: topic)
```

- `recall("A标签")` lists topic only.
- `recall("A标签:workflow")` lists workflow only.
- `recall("A标签:<name>")` browses any concept.
- `kind` is a human decision, not derived from coverage.

### B — per-turn labels

`generic` is the topic+workflow union for compatibility. `genericTopic` and
`genericWorkflow` carry the split. B is display/feature material, not A browse.

### C / K

Both are session-local files:

```text
sessions/<id>/cmap.md
sessions/<id>/keywords.md
```

No fallback to another session, a persona, or the old global table.

## 5. Recall

```text
recall({ query?, recent?, sinceTurn? })
```

| Query | Result |
|---|---|
| none | interpret current user message |
| `A标签` | topic inventory |
| `A标签:workflow` | workflow inventory |
| `A标签:<name>` | area hits for that concept |
| `B标签` / `C标签` / `K标签` | namespace inventory |
| `B标签 <v>` / `C标签 <v>` / `K标签 <v>` | namespace search |
| plain text | literal + alias + K/C/A |

- Index and vocabulary come from the current session only.
- `via` is `A | B | C | K | live`.
- `intervals` keeps every match; the injected note is bounded.
- A result is candidates, not facts; open the cited turn/seq.

## 6. Compaction and receipts

```text
measure
-> planFold(policy)
-> choose oldest balanced range
-> summarize range to [gist]
-> keep protected tail
-> record fold + pass
```

Band:

```text
high = 0.48 W       start a pass
low  = 0.32 W       target request
emergency = 0.65 W
emergencyTo = 0.42 W
protect = 0.14 W
maxPerBatch = 190k
minAction = 24k
```

The continuity preset uses this balanced band from 4.9.122. On the measured
0b window (baseline 133,272) the floor is ~244.2k, so the 253.6k low target is
reachable with ~9.4k headroom; .14 is a conservative default, not a guarantee. One pass removes
~127k, below the 190k cap; emergency 0.65→0.42 is 182k, so the 190k cap is
kept for emergency drainage.

One pass folds one oldest contiguous range. `budget` caps the folded **surface**
tokens only; the associated non-surface prefix can leave with it, so actual
request reduction can exceed the budget. Measured: pre 375,803 → next request
201,756 (174,047 gone) while budget was 122,179 and folded surface was 114,373.
The selected end must also be tool-pair balanced, so `afterTokens` can be above
the floor. This is expected, not a measurement error: the measured 0b pass was
+3,639 above its floor. Reachable floor:

```text
floor(T) = (protect * W + baseline(T)) / W
```

`baseline` is not constant. For the pass decision, use the baseline at the
triggering request (`preBaselineTokens`); `afterBaselineTokens` describes the
post-fold state and must not be used as the pass floor. The measured 0b pass
closed at preBaseline 133,272 + .16W = 260,084, and afterTokens was 263,723
(+3,639 from the tool-pair cut).

`protect` is calibrated once, at the first band-high trigger, from that
request's preBaseline:

```text
protect_eff = clamp((low*W - preBaseline - margin)/W, 0.10, 0.20)
margin = 0.01*W
```

The same fold uses the calibrated value; it is then frozen for the session
(protect_source=calibration, B0=preBaseline, margin recorded). If calibration
is unavailable, the default .14 is used (`protect_source=default`). Later folds
compare the suggested protect against protect_eff; a gap >= 0.02 produces one
suggestion, never an automatic policy change. If protect_eff clamps at .10 and
floor >= low, both "low unreachable" and `low_min = floor + margin` are
reported.

Long-session data (5,498 measurements, baseline/surface median 0.519) shows
that .14 is not a guarantee: floor = baseline + .14W is below low only while
baseline < 142,663, and three of six sampled pre-fold baselines were above
that. The drift criterion therefore watches protect distance, not just a
baseline percentage.

Receipt:

```text
[continuity:fold] seq <from>–<to> · N 条 · tokens · reason=...
压前 ... → 压后 ... · window ...
```

Files:

```text
~/.dsh/continuity/passes.jsonl       append-only, no 24-row cap
~/.dsh/continuity/folds.json         from/to/gistSeq/at;
                                     new folds also count/compactionId
~/.dsh/continuity/sessions/<id>/dropped-ranges.json
                                     per-session merged ranges + coverageFrom
```

`sessions/<id>/dropped-ranges.json` merges only that session's folds (history
before pass receipts) and passes. The global `dropped-ranges.json` is no longer
written; merging different seq spaces was invalid.

## 7. Audit

Every 200 turns, the per-session audit reads the session index and the session's
concepts:

```text
vec + chatter + keywords + conceptScores
k = clamp(round(N/50), 20, 60)
size >= 10
topicMax < 0.5
```

The result is a pending hint in the session's `expand-hint.jsonl`. It does not
edit concepts automatically. An empty A table skips audit rather than failing.

## 8. Panel

`/dsh-continuity/bc.json?sessionId=<id>`:

```text
enabled persona -> available with that session's A/B/C/K
disabled        -> persona-disabled
unknown         -> bc-index not found
```

The client reads `sessionId` from slot props. On `persona-disabled`, it closes
the tab. The panel is read-only and never compacts.

## 9. Peer

```text
peer_message({ to, text, from? })
POST /dsh-continuity/peer
```

`to` must be an exact live session id. No newest/active fallback.

## 10. Isolation guard

The host registers a best-effort `tools.guard`:

```text
each session may touch only its own sessions/<id>/ directory
another session's continuity files are denied
```

This is not an OS boundary. Arbitrary code with full access can bypass it;
strong isolation needs ACL/container. The guard exists to stop normal
edit/write/shell tools from crossing sessions.

## 11. Injection prefixes

```text
[continuity:boot]    onboarding
[continuity:audit]   audit suggestion
[continuity:fold]    pass receipt
```

Plugin-injected `role=user` messages start with `[continuity:*]`.
`[追忆]` is a recall tool result.

## 12. Code map

```text
src/index.mjs                  host routes, panel, guard install
src/engine.mjs                 compaction, pass receipt, fold record
src/state.mjs                  passes, dropped-ranges
src/policy.mjs                 band math
src/recall-tool.mjs            A/B/C/K retrieval
src/memory/bc-pre-step.mjs     per-session dispatcher
src/memory/bc-index.mjs        JSONL codec
src/memory/bc-index-updater.mjs turn labelling
src/memory/bc-panel-state.mjs  panel projection
src/memory/concepts-file.mjs   A parser (kind)
src/memory/persona.mjs         identity/enable/session paths
src/memory/onboarding.mjs      boot marker/scaffolds
src/memory/bc-audit.mjs        audit + hint
src/threads-store.mjs          per-session rules/habits
src/folds-store.mjs            folds.json
src/session-guard.mjs          best-effort tool path guard
client.js                      right tab
cordis.patch.yml               bundle patch
```

## 13. Authoritative layout

`docs/SESSION-LAYOUT.md` is the authoritative path/permission matrix:

```text
sessions/<id>/                 one complete set per session
personas/                      deprecated archive; persona.json enable only
global folds/passes            engine-owned
model tools                    own session dir + workspace only
```

## 14. Invariants

```text
Every session owns A/B/C/K/rules/habits/index.
No cross-session vocabulary or rules inheritance.
A topic browse excludes workflow by default.
A candidate is not a fact.
[gist] is reconstruction, not verbatim.
A pass receipt is append-only.
floor(T) depends on the current baseline.
No extra prompt-classification/tagging/workline layer in safe mode.
Tool guard is not an OS security boundary.
```
