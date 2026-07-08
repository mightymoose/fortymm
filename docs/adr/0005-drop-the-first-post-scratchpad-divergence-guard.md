---
status: accepted (supersedes ADR-0003)
---

# The first-post scratchpad-divergence guard is removed; propose/accept is the only reconciliation

ADR-0003 added a board-level guard on the first `POST /matches/{id}/results`:
every committed scratchpad game with a score had to reappear in the proposed
board with identical points, or the propose was rejected 409
(`_scratchpad_divergence` / `MatchResultBoardConflict`). Its purpose was to stop
a stale poster from silently overwriting a game a concurrent participant
committed to the shared scratchpad (issue D1 / #747-B2).

**We remove that guard entirely.** The first post no longer inspects the
committed scratchpad; it compacts, validates the board is decided, and mints the
result. The only reconciliation left is the negotiation itself — a rated
two-human result *stands* for the opponent to accept or counter — plus the
unchanged per-game optimistic-concurrency `version` guard on
`PUT .../games/{n}/scores`, which still protects a single shared cell from a
concurrent overwrite.

## Why

The guard turned out to be a **bypassable speed-bump that only ever caught
accidents**, and it was actively breaking the happy path (#825):

- **It never stopped a determined poster.** On the 409 the poster re-syncs,
  overwrites the opponent's game via the version-guarded per-game `PUT` (they now
  hold the fresh version), and finalizes their board anyway — two extra taps. So
  the guard's only real function was catching a poster who was *stale and didn't
  realize the board moved under them*.
- **Its value inverts across match types.** A rated two-human result *stands* for
  acceptance, so the opponent's review is already a second net against a stale
  overwrite. A solo match has one author and can never diverge — the check is a
  pure no-op there. The one place it was the *sole* net is an **unrated**
  two-human match, which self-finalizes with no acceptance and (matches are
  terminal once completed) no recourse.
- **We chose not to protect that case.** An unrated match is casual; its accuracy
  is the poster's responsibility. The poster already finalizes unilaterally — it
  is incoherent to force conscious reconciliation on the scratchpad and then let
  them mint any board they like. We accept an occasional wrong *unrated* record as
  the cost of a much simpler model.
- **It caused #825.** The client compacts a gappy out-of-order clinch
  (`[G1, G3] → [G1, G2]`) before posting (ADR-0002), but the guard joined the
  proposal to the committed scratchpad **by game number**. The renumbered board
  had no `game 3`, so the guard read the committed `game 3` as "dropped" and
  false-rejected a legitimate solo/two-human clinch — discarding the entered
  deciding game, soft-locking the finalize (re-deciding reproduced the same
  compacted board and the same 409), and showing "saved by someone else" copy
  that is nonsensical in a solo match.

The residual risk we take on is D1 on *rated* matches: a stale poster's
accidental overwrite now rests entirely on the opponent reading the board before
accepting. We judge acceptance-review sufficient for the rating-bearing case, and
we keep the per-game version guard for concurrent single-cell edits.

## Rejected alternative: fix the numbering so the guard works (send the raw board)

The client could POST the raw, un-compacted board so the by-number comparison
lines up (the server already re-compacts before minting). This fixes #825 while
keeping the guard. Rejected: it preserves a guard whose entire value is a
bypassable accident-catcher, in exchange for keeping the interstitial, the
`MatchResultBoardConflict` codegen surface, and the 409 reconcile path alive. The
deletion is simpler and, given we don't care about unrated accuracy, loses
nothing we've decided to protect.

## Rejected alternative: narrow the guard to rated matches only

Gate the guard behind `_requires_confirmation` (rated + two-human). Rejected as
the exact inverse of the analysis: rated is where acceptance *already* backstops
a stale overwrite, so narrowing to rated keeps the guard precisely where it is
most redundant. If we don't value it on unrated (where it is the sole net), it
isn't worth keeping on rated (where it is a second net).

## If reconciliation is needed later

The escape hatch is to make a **completed match correctable** — let a participant
supersede a finalized result with a "replace result" correction (today
`_TERMINAL_STATUSES` closes a completed match to all proposals). That gives
post-hoc recourse for a wrong record without resurrecting a pre-mint guard.
Revisit only if silent overwrites become a real complaint.

## Consequences

- Delete `_scratchpad_divergence` and the first-post divergence 409 in
  `post_match_result`. The "a result already exists" negotiation-conflict 409 and
  the lock-unavailable 409 stay.
- Remove the `MatchResultBoardConflict` schema and regenerate `schema.d.ts` and
  iOS `Types.swift` (the `openapi-schema` drift guard will require it).
- Delete the score-entry board-conflict interstitial, its `divergingGames`
  computation, and the finalize `onError` re-sync-from-`committed_match` branch;
  generic finalize-error surfacing (for the concurrent-post 409) stays.
- Drop the divergence simulation from the MSW mocks and the interstitial tests.
- ADR-0003 is superseded. ADR-0002 (client compacts before posting) is unaffected
  — nothing now depends on the pre-compaction numbering.
