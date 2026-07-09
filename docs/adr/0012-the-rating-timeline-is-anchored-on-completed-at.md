---
status: accepted
---

# The rating timeline is anchored on `completed_at`, and each user seeds from their own first affected match (#749, #244)

`recompute_league_ratings` had two defects that turned out to be one defect wearing
two hats.

**The seed was global.** `_seed_states` loaded every affected user's rating state as
of a single cutoff `t_start` — the earliest completed rated match of the *seed*
users. But the cascade only marks a match affected when one of its participants is
*already* affected. So a user B who joins the cascade late, via a later match against
an already-affected user, and who played a non-affected match `M_b` in between, was
replayed from a seed that predates `M_b`. `M_b` is neither replayed (it isn't
affected) nor reflected in B's seed (it postdates `t_start`). B's recomputed rating
and its `previous_rating_value` chain are silently wrong (#749).

**The timeline was anchored on a mutable column.** `Match.updated_at` is
`onupdate=func.now()` — it moves whenever the row is touched. The recompute used it
in all four places that define the timeline: computing `t_start`, filtering the
replay window, ordering the replay, and stamping `created_at` on the history rows it
wrote. Meanwhile the live path (`result_acceptance.py`) stamps no `created_at`, so
those rows take the `func.now()` server default. Since the live rating write happens
in the *same transaction* as `mark_completed()`, and Postgres `now()` is
`transaction_timestamp()`, live rows already carry `created_at == completed_at`
exactly. The recompute was the only writer on the wrong axis (#244).

These interlock: a per-user seed is a *cutoff*, and a cutoff is only meaningful on a
stable, monotonic axis. Fixing the seed on `updated_at` would have shipped a
correctness argument that doesn't hold — editing any old completed match silently
reorders the replay.

## Decision

**The rating timeline is ordered by `Match.completed_at`** — stamped once by
`mark_completed()`, cleared only when a match is un-completed, and explicitly
documented on the model as the axis that "history/form/H2H queries anchor on, not
the mutable `updated_at`." The recompute now obeys the rule the rest of the codebase
already followed. The replay stamps `RatingHistory.created_at = match.completed_at`,
which is what the live path was already producing by accident.

**Each affected user seeds from the state as of their own first affected match**,
not from a global `t_start`. `_seed_states` takes a per-user cutoff. The
`rating_history` rows of a non-affected match are left in place and *read* as the
seed, which is sound precisely because a non-affected match had both participants at
unchanged incoming ratings — its stored row is already bit-for-bit what a replay
would produce.

Manual / import / initial history rows carry no `match_id` and keep their wall-clock
`created_at`. They share an axis with `completed_at`, which is itself a wall-clock
instant — just an immutable one — so the per-user cutoff stays well-defined.

## Considered option: widen the replay window instead of fixing the seed

Issue #749 offers a second fix — pull each cascade user's intervening non-affected
matches into the replay window. Rejected: it is **redundant and unbounded**. A
non-affected match has both participants at unchanged incoming ratings, so replaying
it reproduces identical numbers, while dragging its *other* participant into the
cascade for nothing. That participant then drags in theirs. The correct-and-bounded
fix is to seed from the state the non-affected match already recorded.

## Considered option: backfill existing `rating_history` onto the new axis

Rejected as unnecessary. The database is being wiped, so there are no legacy rows to
repair. Note the backfill would have been close to a no-op regardless: only rows
written by a *prior* recompute could drift, and only for a match edited after it
completed.

## Consequences

- `Match.completed_at` is nullable, and the recompute's queries filter
  `status == completed`, so the non-null invariant holds but is invisible to mypy —
  expect narrowing asserts at the read sites.
- An empty timeline is no longer a no-op. See ADR-0013: `t_start is None` now means
  "this user's state is the strategy's initial state," and the recompute rewrites it
  rather than returning early. That is what makes the module's own idempotence claim
  ("reads current state and rewrites it deterministically") true for *every* input.
- `matches.py` (rating history) and `dashboard.py` (the sparkline) both order by
  `rating_history.created_at`; they inherit the stable axis for free.
