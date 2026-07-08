---
status: accepted
---

# The per-game score endpoints take the blocking match row lock

The three per-game score endpoints — `create`/`update`/`delete_game_score` —
loaded the match with `_load_match_for_scoring(...)` **without a row lock** and
then checked `_enforce_scorable` on that lock-free in-memory state. Meanwhile the
sign-off transitions (`post_match_result`, `/results/{id}/acceptance`) take the
`matches` row lock via `_lock_match_row`, and a first `post_match_result` freezes
the scratchpad and clears/reinserts `match_games` under that lock. So the
scratchpad-scorable gate on the score path was a lock-free TOCTOU: a score write
could evaluate "still scorable" *before* a concurrent first propose froze the
board and then commit *after* it (#835).

**We take the match row lock on the score-endpoint load path too** — the three
endpoints now load with `lock=True`. Because `_load_match_for_scoring` acquires
the lock *before* the eager load, the existing `_enforce_scorable` immediately
after becomes a correct under-lock recheck: a score write now serializes against a
concurrent first propose and either holds the lock (so the propose's `NOWAIT`
bounces to a clean 409) or waits and re-reads the frozen board (a clean 409). No
other logic changed.

## Considered option: NOWAIT parity with `post_match_result`

`post_match_result` locks `NOWAIT` so a double-tapped *finalize* 409s fast instead
of parking a pooled connection on the lock (#641). Mirroring that on the score
path was rejected. The common contention on the score path is **score-vs-score**
(two participants tapping in points), which today resolves gracefully via the
`uq_match_games` / per-game `version` guards. `NOWAIT` would make every concurrent
score-vs-score write spuriously 409 "a result is being posted" — a regression in
the common case to fix a rare one. The **blocking** lock serializes the two brief
single-row score commits and, against a real propose, produces the *correct*
frozen-board 409. Score writes have none of the long-in-flight duration that made
`NOWAIT` matter for finalize.

## Consequences

- One lock closes a family of races off the same root cause: the #835 create-stray
  (a game the frozen result never described, left unremovable because the match is
  now frozen), and the delete/update-vs-propose races.
- A score write can now briefly make a *concurrent* propose's `NOWAIT` trip — the
  propose 409s "a result is already being posted" while a score write holds the
  lock. The window is a single-row commit and the client action (refresh/retry) is
  correct either way.
- **Empirical correction to the audit.** The 2026-07-07 audit's finding #8 called
  `delete_game_score` under a race an unhandled **500** (`StaleDataError`). It is
  not: the models carry no SQLAlchemy `version_id_col`, so a stale delete-orphan
  whose row a concurrent propose already removed only emits a benign `SAWarning`
  and returns a lying `200` — never `StaleDataError`. The one genuine pre-fix 500
  was on a *different* path: `update_game_score`'s `db.refresh(game.score)` of a
  row the propose deleted raises `InvalidRequestError`. The lock closes both, and
  the delete loser now re-reads and 404s cleanly instead of the lying 200.
