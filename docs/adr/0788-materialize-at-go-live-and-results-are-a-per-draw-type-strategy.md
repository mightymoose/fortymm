# 788. Tournament matches materialize at go-live; an event's results are a per-draw-type strategy

Date: 2026-07-13 (numbered by issue #788 — sequential numbers collide across
concurrent worktrees; see ADR-0786's note and the duplicate 0008s in this directory)

## Status

Accepted — design for slices C1/C2 of epic #780 (#788, #789), decided before
implementation. Refines two positions ADR-0786 left open or stated differently
(the completion→advance seam, and "standings is not a strategy method").

## Context

ADR-0786 laid the substrate: persisted `tournament_fixtures`, a pure
`DrawStrategy` per draw type (`plan_initial` + idempotent `advance`),
materialization gated on the tournament being `live`, and a completion-driven
"write `winner_entry_id`, run `advance()`" mechanism. It deliberately deferred
the *mechanics* of C to "a later slice": how a completed match writes back and
re-advances, how a fixture becomes a real propose/accept match, and what an
event's **results** are. This ADR pins those.

Three facts constrain the slice:

- **Only round-robin has a strategy.** #785's `SingleElimStrategy` is unmerged
  (`strategy_for` still raises `UnsupportedDrawType` for it), so round-robin is
  the only draw type that can be cut today. Round-robin's `advance()` fills **no**
  sides — every pairing is known at the cut — so after go-live materializes the
  pool, its `advance()` is *always* empty. The "fill the winner into the next
  round" behaviour is entirely single-elim's, and there is nothing to test it
  against yet.
- **A match completes at two sites, split on rated-ness.** `matches.py`'s result
  path self-accepts and completes an **unrated** match immediately; the
  `result_acceptance.py` path completes a **rated** match on acceptance (or
  retirement auto-accept, ADR-0008). Both call `Match.mark_completed()`.
- **The event carries almost nothing to copy.** `TournamentEvent.match_settings`
  is only `{rated, length_games}`. `TournamentEntry` is a **single** `user_id` —
  there is no partner/roster model — so a `doubles`/`teams` event has no way to
  say *which two people* form one side.

## Decision

### Scope: round-robin, singles

C1/C2 target **round-robin** and **singles**. Single-elim advancement rides
along for free when #785 lands, because every mechanism below is
draw-type-agnostic. A non-singles event is **refused at draw-cut** (`POST
…/draw`), not at go-live: a round-robin draw over single-`user_id` entries is
meaningless for doubles, so there is nothing worth cutting or previewing, and the
earliest failure is the clearest one.

### A ready fixture materializes into an ordinary match at go-live

Materialization (ADR-0786 gated it on `live`) is now *consumed*: the go-live
transition's first `advance()` turns **every** ready round-robin fixture into a
real `Match` in one stroke — the whole pool. The match is created:

- `status = in_progress` — both players are known and committed; there is no
  accept-to-*start* step (propose/accept is about the *result*).
- `league_id` = the tournament's league; a new `MatchSettings` with `best_of =
  length_games`, `affects_rating = rated`, `team_size = 1`, and **default**
  `verification_policy`/`retirement_window` (the event holds nothing to copy —
  capturing tournament-specific retirement is a later slice).
- `created_by_user_id` = the tournament **owner** (director). A tournament match
  has no player-initiator; the director's go-live created it. The field grants no
  scoring rights (those are by side participation) and appears in no player-facing
  list, so this is honest provenance, not a privilege.
- **side 1 ← `entry_a`, side 2 ← `entry_b`.** This fixed convention is what lets
  the winner read back with **no new column**: the completed match's winning
  `MatchSide.side_number` maps `1 → entry_a_id`, `2 → entry_b_id`.

Idempotence is `fixture.match_id`: a re-run of `advance()` never re-proposes.

### The completion→advance seam is one synchronous call, wired at both sites

A single domain function — `on_match_completed(db, match)` in a new
`tournament_advancement` module (not the tournaments *router*, so the dependency
points one way: the match-completion services import tournaments, never the
reverse) — runs **synchronously, inside the completion transaction/row-lock** the
score endpoints already hold (ADR-0009). It looks the fixture up by `match_id`
(indexed), returns early on a miss (the common non-tournament case), records
`winner_entry_id`, and runs `strategy_for(draw_type).advance(...)`, materializing
anything newly ready.

It is called from **both** `mark_completed()` sites, so it covers rated *and*
unrated tournament matches uniformly — an unrated match moves the draw forward the
instant its result is posted; a rated one the instant it is accepted. The draw
never moves on an *un*accepted proposal, and a **correction** (which un-completes
the match) correctly stops moving it until re-accepted. The safest wiring is a
single `finalize_match()` helper both paths call, so a future third completion
path cannot forget the hook.

A **synchronous** call (not an RQ job or an event bus) is deliberate: the advance
is cheap, an atomic "result accepted ⟹ the draw reflects it" is far simpler to
reason about than an eventually-consistent one, and there is exactly one consumer
— an event bus would be machinery without a second subscriber.

For round-robin the seam materializes nothing after go-live (the pool is already
whole) and `advance()` is empty. That is the uniform seam being honestly empty,
not dead code: the same call is load-bearing the moment single-elim lands.

### An event's results are a *separate* per-draw-type strategy family

ADR-0786 said pool standings are "a read-model over decided fixtures —
deliberately **not** a strategy method." That still holds for the **shared
`DrawStrategy`** interface: `standings()` there would force single-elim and
double-elim to implement a table they do not have. But the underlying concept —
**results**, *how an event turned out* — **is** universal across draw types; it is
only *shaped* differently (a round-robin's results are its **standings** table; a
single-elim's are its placement and **champion**). So results get their **own**
strategy family, `results_for(draw_type)`, mirroring `strategy_for`'s exhaustive
`match`/`UnsupportedDrawType`, in a pure `results` module. This slice implements
only `RoundRobinResults`.

`RoundRobinResults` orders a pool by an **extensible chain** of tiebreakers: wins
→ head-to-head *when exactly two are tied* → game difference (games won minus
lost) → games won. (Head-to-head is applied only to two-way ties; a 3+-way tie
can cycle, so it falls straight through to game difference rather than a recursive
mini-league.) "points diff" from issue #789 is dropped: points are not modelled,
so the finest granularity is a **game**.

### Everything derives from the live matches; nothing is a snapshot

Standings, **event-complete** ("every fixture decided"), and **champion**
(standings position 1 of a complete event) are all computed **live from the
fixtures' currently-`completed` matches** — the results strategy is fed small
frozen **outcome value objects** (winner + per-side games) projected from those
matches, keeping the `results` module pure. Because nothing is snapshotted, a
**correction** or **voided match** is reflected the instant it leaves `completed`,
with **no extra hooks** — the single completion hook suffices.

`winner_entry_id` *is* still written on completion, for the uniform mechanism and
as the substrate single-elim's `advance()` will plan from — but **no round-robin
read path reads it** (they derive from the matches, for correction-safety). It is
therefore written-but-unread in round-robin: the acceptable price of one uniform
seam. Zero drift would cost an un-completion/void hook to clear it; not worth it,
since displays never read it.

**Champion and event-completion are derived, never stored, and `archived` stays a
manual director action** — auto-archiving on the last result is a surprising
side-effect on an irreversible status edge, and a multi-event tournament is not
"done" because one event finished.

## Consequences

- The completion path gains one synchronous call at two sites (ideally one
  `finalize_match()` helper); no queue, no event bus, no per-draw-type code at
  result sites — `on_match_completed` is the one mechanism.
- There are now **two** strategy families: `DrawStrategy` (run the draw) and the
  results strategy (compute the outcome). Each is pure, registry-dispatched, and
  exhaustive-`match`ed, so a new `DrawType` is a type error in both until handled.
- A corrected or voided tournament match needs no bespoke round-robin handling:
  standings/complete/champion recompute from live match state. Single-elim's
  "un-advance a reversed result" (a downstream match built on a now-reversed one)
  is genuinely harder and is deferred to #785, consistent with ADR-0786 parking
  the "play has begun" merge-collision case there too.
- Results appear inside the existing tournament-detail BFF (one endpoint per
  page); the only structural additions are the `results` module and the
  materialization/advancement wiring. Standings render live throughout play.
- Doubles/teams tournaments remain unplayable by construction (refused at cut)
  until an entry-partner model exists — an explicit no, recorded so it is not
  mistaken for an oversight.
