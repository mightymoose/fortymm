---
status: superseded by ADR-0005
---

# A first-post proposal is rejected when it disagrees with the committed scratchpad

> **Superseded by [ADR-0005](0005-drop-the-first-post-scratchpad-divergence-guard.md).**
> The guard described below was removed: it only ever caught *accidental* stale
> overwrites (a determined poster routes around it), and it false-rejected
> legitimate out-of-order clinches (#825). Reconciliation now rests entirely on
> propose/accept plus the per-game version guard. Kept for historical context.

Before any result exists, the working board is a **shared scratchpad**
(`match_games` + `match_game_scores`) that either participant edits one game at a
time via `PUT .../games/{n}/scores`, guarded by an optimistic-concurrency
`version` token: a write whose expected version is stale 409s rather than
overwriting a concurrent participant's save.

"Post result" (the first-post `POST /matches/{id}/results`) bypassed that guard.
It assembles a board **client-side** and the server's `_commit_canonical_games`
**clears + reinserts** `match_games` from the payload with no comparison against
what's committed (the `MatchResultsWrite` contract is literally "the list is
canon… no merge"). So a poster with a stale view — who never saw a game the
opponent committed to the scratchpad — silently overwrote it by posting.

We close the gap with the board-level analogue of the per-game version guard:
**on a first proposal, every committed scratchpad game that has a score must
appear in the proposed board with identical points, or the propose is rejected
409** (`_scratchpad_divergence` / `MatchResultBoardConflict`). *Additions* — a
proposed game with no committed score (an empty cell, or a game the scratchpad
never held) — are allowed; filling in the deciding games is the whole point of
posting. The 409 carries the **whole committed match** so the client re-syncs
from the body (no refetch) and re-decides against reality. The check is gated
**behind** the existing "a result already exists" gate, so it only ever fires
pre-result: once a result stands, the negotiation conflict owns the moved-on
state and nothing is undone. This is the UI-reachable face of the "post overwrites
a committed game" hazard (issue D1 / #747-B2).

## Rejected alternative: a per-game version token on the propose payload

The faithful mirror of the per-game guard would be to carry an
`expected_version` per game in `MatchResultsWrite` and reject on a stale version.
Rejected:

- It forces a request-schema change across **three CI-gated codegen boundaries**
  (`openapi.json` → `web-client` `schema.d.ts` → iOS `Types.swift`), for a guard
  that only needs to answer "does this board still agree with what's saved?"
- It **collides with compaction.** A decided board is compacted (empty slots
  dropped, games renumbered `1..N`) before it's minted; versions keyed to the
  original game numbers would need a preserved mapping through the renumber.
- The only thing a version token catches that value-comparison doesn't is
  **same-value churn** (save 11-4, someone re-saves 11-4) — which by definition
  loses no data and needs no conflict.

Value-comparison is complete for the actual defect (a *different* committed score
being overwritten) and touches no schema.

## Rejected alternative: let "Post result" force-overwrite

Keeping the "list is canon, no merge" behavior and simply surfacing a warning was
rejected: silent overwrite of a committed game **is** the bug. Pre-result, the
only sanctioned way to change a committed game is the version-guarded per-game
`PUT`, which makes the poster consciously reconcile against the opponent's value.
"Post result" means *mint the agreed scratchpad*, never *overwrite-and-mint*.
(Full-board re-score is the **correction** surface — ADR 0001 — which exists only
*after* a result stands and the scratchpad is frozen.)

## Consequence for the front end

The reconcile is server-authoritative and lands the poster on the *true* board.
`useProposeResult`'s `onError` re-syncs the caches from `committed_match`, and the
score-entry screen replaces the score pad with a **blocking interstitial** ("the
score changed — a game was saved by someone else") whose single action resumes
scoring at the next still-unplayed game (or the match page when the committed
board is already *decided* — keyed on the decider, not on the first empty slot, so
a board clinched before its last game doesn't point "Resume" at an unplayable
game). The interstitial is computed ahead of the screen's participant/decided/
out-of-range nav bounces so a decided committed board can't preempt it. It never
presents the opponent's committed game as the poster's editable draft.

## Known non-goal: delete-divergence

A game the opponent *deletes* from the scratchpad pre-post has no committed score
to compare against, so a stale board that resurrects it reads as an addition and
posts. This is out of scope: it's rare (`delete_game_score` has no version guard
either), and the resurrected board is still a decided board the poster is claiming
happened. Revisit if pre-result deletes become a real conflict source.

## Compaction caveat

The client compacts the board before sending, so for an **out-of-order clinch**
(a gappy board, e.g. game 5 scored with game 4 blank) the server compares
renumbered payload games against the gappy committed numbers and may **falsely**
flag divergence. That failure is conservative — a false *reject*, never a silent
overwrite — and the poster simply re-syncs and re-decides. Contiguous boards (the
overwhelming common case, including every D1 repro) compact to themselves, so the
numbers line up and the check is exact.

## Bug context

Fixes D1 (reproduced on matches `13df574e` / `3da4be11`): a rated best-of-5 where
the poster saved games 1–2, the opponent committed game 3 in their own favor
(real board 2-1), and the poster's stale one-tap "Post result" proposed 3-0,
silently replacing the opponent's game 3 with no conflict on either side.
