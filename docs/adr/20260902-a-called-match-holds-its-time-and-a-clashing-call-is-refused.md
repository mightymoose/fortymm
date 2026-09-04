# A called match holds its time, and a clashing call is refused

Date: 2026-09-02
Status: accepted

Amends ["The schedule is solved; the call is pinned"](20260716-the-schedule-is-solved-the-call-is-pinned.md).
Supersedes the solver decision in ["A called match holds its table and slides later"](20260719-a-called-match-holds-its-table-and-slides-later.md).
Closes the player-facing half of #1661 (items 1, 2 and 3). Mechanism tickets: #1401, #1513, #1514, #1516.

## Context

The 2026-07-19 amendment made a called match's start a solver variable that can slide later.
It fixed a real infeasibility (#1114). It also listed a consequence it accepted: an unpinned
match can bump a called, already-promised match later, and two overlapping calls auto-resolve
by sliding one of them.

The 2026-09-02 QA pass showed what that costs a player:

- One director call sent a player two messages in the same second. The first named the time
  the director picked. The second, from the re-solve, named a later time the solver stored.
- A routine call for other players re-timed a match that was already called and being
  played, and pinged both of its players. Every later call pinged them again.
- The director placed a player onto a table that already held that player's called, unplayed
  match. The app accepted it. The player held two "head to the table" instructions.

The fixed-obstacle merge from ["Overlapping in-progress matches are tolerated and
reported"](20260720-overlapping-in-progress-matches-are-tolerated-and-reported.md) removed the
reason the slide existed. Two fixed intervals that overlap are merged into one obstacle
before `AddNoOverlap`, so fixed-versus-fixed can no longer make a solve infeasible.

## Decision

### A pin is a constant in both dimensions

In `api/app/scheduling.py` a pinned fixture is a fixed obstacle, like an in-progress match.
Its table and its start never vary. The solver merges pin intervals into the same per-table and
per-player fixed spans that in-progress occupancy and rest shadows use, so a pin that overlaps
a running match, or another pin, cannot wedge the day. Unpinned fixtures schedule around the
merged union.

The apply in `api/app/schedule_solves.py` echoes a pin's placement and writes nothing for it.
The "slid later" branch is gone. The only correction the apply still sends is the
withdrawal void.

### A live call that clashes is refused

In `api/app/tournament_placement.py`, while the tournament is live, a full placement of a
fixture with both entrants known is a call. Before the call is written, the verb reads the
tables and the users that unfinished `in_progress` matches in this tournament hold, excluding
the fixture's own match. If the placement's table or either of its players is held, the verb
raises `PlacementClashError`. The HTTP adapter answers 409 with a sentence that names the
table or the player and the match that holds it. Nothing is written and nobody is notified.

This is the same occupancy read the automatic call pass already uses
(`app.match_calls._held_resources`). The director's hand and the solver's call now obey one
gate.

Pre-live placements stay soft, as ADR-0790 decided. A pre-live placement calls nobody, so a
clash there is a flag on read, not a refusal.

## Consequences

- A player who was told a table and a time keeps that table and that time. A later call, a
  completion, or a re-solve for anyone else never moves them and never pings them.
- A director who tries to call a player, or a table, that is still busy gets a refusal that
  names the clash. The players hear nothing until the director picks a free table or waits.
- A called match behind a match that runs long waits at its table. The players are not
  re-timed. This is what a control desk does when it says "a few more minutes on Table 3".
- The web client's confirm dialog names the time the director picked, and that is the time
  the app stores, because the solver no longer substitutes one (#1513).
- The unit tests that asserted the slide now assert the hold: a pin overlapping an in-progress
  occupancy is echoed unchanged and the solve stays feasible.
