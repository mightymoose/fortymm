# A tournament match is called only when its table and players are free

Date: 2026-07-18 (date-numbered — sequential numbers collide across concurrent
worktrees; see ADR-0788's note and the duplicate 0915s in this directory)

## Status

Accepted — fix for issue #1106, decided before implementation. **Amends
ADR 20260716** ("the schedule is solved, the call is pinned") and **ADR 20260717**
("a tournament match is born scheduled and goes live when called"). Both assumed
the call fires when a **placement**'s predicted start enters the ~10-minute
call-ahead window. This ADR keeps the call the same *event* (tell the entrants,
flip `pending → in_progress`) but gates *when* it may fire on the fixture's
physical resources actually being free. Everything else those ADRs decided
stands.

## Context

The caller (`app.match_calls.call_due_fixtures`, reached from both the guarded
solve-apply and the pin tick) started a match the moment its **placement**'s
predicted start entered the call-ahead window (`_due_for_call`:
`scheduled_start <= now + CALL_AHEAD_MIN`), with **no check that the match's
table or its players were free**.

But a placement's start is a **prediction, not a promise** (the glossary's
`Placement`). The prediction is derived from an estimated match length. When a
match instead runs long — the pathological case is a live tournament that simply
sits idle, nobody entering a score, so a match stays `in_progress` indefinitely —
the estimate is wrong, yet the *next* fixture's predicted start still creeps into
the window on schedule. The caller then starts it. That produces a **second
`in_progress` match sharing the same table and/or the same human** as the one
still underway.

A started (`in_progress`) match is a **pinned** placement whose position the
solver holds at its *actual* occupancy — "a running fixture's pin is superseded
by its actual occupancy" (`app.scheduling`). Two started matches on one table, or
two on one human, are therefore **two immovable fixed intervals that overlap**.
The next solve is over-constrained before search begins and returns `infeasible`
in ~1 second (observed on UAT: ~20 `in_progress` matches, ~19 players each
started in two at once). No solver time budget can fix it — the contradiction is
in the inputs, put there by the caller.

The root trap: **the call-ahead window is priced off a prediction.** The only
moment we actually *know* a table will be free is when the match on it
**completes**. And completion already does the right thing — it fires a
`match_completed` solve (`app.tournament_advancement`), and the guarded apply
calls due fixtures in that same transaction (`app.schedule_solves`). The pin
tick's clock-driven polling was the workhorse only because the *old* model made
matches become due by the clock; an event-driven caller barely needs it.

Fixing this in the solver instead — teaching it to *tolerate* two started
matches on one resource, or to explain *which* inputs conflict — was rejected as
the primary fix: two humans cannot be one, and a table cannot host two matches,
so the contradiction is real, not a modelling artefact. The caller must not
create it. (Surfacing *why* an infeasible set of pins conflicts is still worth
doing as diagnostics — left to #1102/#1103. With this fix the caller no longer
manufactures that infeasibility, so the diagnostic is defence-in-depth, not the
fix.)

## Decision

### A match is called only when its resources are actually free

The caller flips a fixture `pending → in_progress` (the **call**) only when it
is **due** *and* its **table** and **both its players** are free of any
unfinished `in_progress` match — where a player is identified by their **user**,
so the check holds across events (the same human in two events is one person, as
the solver's no-double-booking already treats them).

- **Due** reads the *prediction* (`scheduled_start` within the call-ahead
  window). **Free** reads *real state* (are there unfinished `in_progress`
  matches on this table / for either user?). **On conflict, real state wins** —
  the classic conflict *is* the bug: the estimate optimistically predicts your
  next match at now (assuming your current one ended), but your current match is
  still `in_progress`, so we do not call.

The guard lives in **`call_due_fixtures`** — the single choke point both the
guarded apply and the pin tick funnel through — as a **cross-row pass** over the
due batch, *not* in the per-row `_due_for_call`/`_due_fixture_clauses`. This is
deliberate and load-bearing: the invariant is inherently cross-row ("at most one
started match per table/human *across this batch*"), so it cannot be expressed as
a row-local predicate — `_due_for_call` cannot see a sibling due fixture
competing for the same freshly-free table. Do not "simplify" the gate by pushing
it into `_due_for_call`; that reintroduces the bug. (The tick's lock-free
`_due_fixture_clauses` EXISTS probe stays resource-blind and may therefore take
the tournament lock on an idle-but-blocked tick only to call nothing — a bounded
no-op at the 60s backstop cadence, left as-is; the authoritative gate is the
cross-row pass here.)

### The invariant: at most one started match per table and per human

The caller can no longer produce two overlapping started matches on one resource.
The solver therefore never receives contradictory fixed intervals from the
caller, and a tournament that sits idle **stalls honestly** — the successor waits
for the current match to complete — instead of wedging itself `infeasible`.

### Calling is event-driven; the pin tick is a clock-only backstop

A **completion** frees a table and re-solves; that solve's guarded apply calls
the freed table's successor **immediately** (bounded by the solve's own latency,
not a poll interval). The call is not made synchronously in the completion
transaction: the successor's placement still predicts a *future* start until a
solve pulls it to now, and calling a stale placement would risk committing a
fixture the fresh solve would not have chosen. The solve remains the single
source of truth for *where* a match goes and *whether* it may be called.

The **pin tick** is demoted to the one case no event covers: a fixture whose
resources are already free but whose predicted start arrives by the *clock* — a
pool **Slot** window opening, or a tournament's very first matches at start time.

### Readiness comes from the estimate, not a speculative pin

The "you're up soon, be near the table" signal is the **soft placement** the
player already sees ("Up next" / the schedule). A pin is a *hard, irreversible*
commitment (echoed verbatim, never reschedulable earlier); using it to deliver a
*provisional* heads-up is the mismatch that caused this bug. We accept a little
table idle (the next players called when the table frees, not up to 10 minutes
early on a guess) over risking an infeasible schedule. A genuine call-ahead, if
ever wanted, must key on *actual match progress* (e.g. the current match is on
its deciding game), never on the clock.

### What is unchanged

- **The director's manual placement stays a pin** — the one deliberate human
  commitment to a future slot, exempt from the resource-free gate (the director
  is deciding, not gambling on a prediction).
- **`pinned_at` is still stamped at the call** — the "was called" record; the
  solver ignores it on a started match (actual occupancy supersedes it), so it
  costs nothing and keeps the two July ADRs' pin/notify machinery intact.

## Consequences

- **The #1106 wedge — an *automatically* self-inflicted one — is gone.** The
  automatic caller can no longer create overlapping started matches, so the idle
  tournament that motivated this issue never hands the solver the contradictory
  fixed intervals that produced the bare `infeasible`. This is scoped to the
  automatic path on purpose: **manual placement stays exempt (see below), so a
  director *can* still hand-place a fixture onto a busy table or human and
  recreate the same overlap.** That is a deliberate-human action, not the
  spontaneous idle-time wedge the issue reported — but it is a live path to the
  same infeasible state, and if it proves a real hazard the honest fix is to
  enforce the one-started-match-per-resource invariant at the go-live transition
  itself (`_go_live_on_call`) with a director-facing override, rather than in the
  automatic caller alone.
- **An idle tournament stalls, it does not wedge.** With no scores entered, the
  next match simply waits — the honest behaviour — and a single score resumes the
  cascade.
- **Slightly less call-ahead lead time.** Players are called when their table is
  free rather than up to ~10 minutes early on a prediction; the "Up next" surface
  carries the anticipation. This is the deliberate trade — flexibility and
  correctness over a lead time the prediction could not reliably deliver anyway.
- **`api/`-only.** No schema change (no new column or status; the guard is a
  predicate), and no web/iOS change — the client already shows scheduled/"Up
  next" matches.
- **The pin tick keeps existing** as a thin clock-only backstop; it is no longer
  the primary caller.
