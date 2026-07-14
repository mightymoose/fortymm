# 790. A placement is a naive, predicted start time on the fixture

Date: 2026-07-14 (numbered by issue #790 — sequential numbers collide across
concurrent worktrees, as the duplicate 0008s in this directory attest)

## Status

Accepted — design for slice D1 of epic #780 (#790), decided before
implementation. The auto-packing **scheduler** it anticipates is a separate,
later slice; this ADR fixes only the data model and the read-only surface D1
ships.

## Context

The Schedule tab (`web-client/.../schedule-tab.tsx`) is a display-only mock: it
draws each pool's reserved **Slot** window on a timeline and knows nothing of
the real matches. #790 as originally written asks to "assign matches to tables +
time slots" with manual assignment first and an auto-packer "optional later,"
plus conflict flagging.

Two facts reshaped that:

- **The real intent is a CP-SAT scheduler that repeatedly re-packs the *unplayed*
  remainder** as the tournament runs (the RQ `solver` queue, today only a
  health-check stub). Manual placement is not a stopgap the solver replaces — it
  is the **director override** the solver must respect. So the durable thing D1
  must get right is the *placement datum and its semantics*, not a throwaway
  hand-assignment UI.
- **C1/C2 already ship the read side.** The detail BFF (`TournamentDetailRead`,
  one-endpoint-per-page) already carries each event's `fixtures` (with `match_id`
  + live `match_status`) and `results` (standings + champion), all Zod-parsed
  client-side, and the Events tab already renders draws + standings. Every
  materialized match is already visible.

## Decision

### The placement lives on the fixture, not the match

A **placement** is two nullable columns on `tournament_fixtures`: `table_id` (a
string-ref into the tournament's `table_catalogue`, the same pattern as
`pool_id`) and a predicted start time. Not on `matches`: the match model is
shared with all non-tournament play and must not grow tournament-only columns;
and a placement can be set **before the match exists** (a round-robin fixture is
known at the cut, before go-live materializes it) and must **survive
materialization** — both of which the fixture, not the match, is the stable home
for. A human PATCH and a future solver write the *same* fields.

### The start time is a naive local timestamp, deliberately not `timestamptz`

`scheduled_start` is a **naive** timestamp (`TIMESTAMP WITHOUT TIME ZONE`) in the
venue's wall-clock frame. This is a deliberate deviation from
`api/CLAUDE.md`'s "datetimes are always timezone-aware" rule — **do not "fix" it
to `timestamptz`.** The placement is validated against its pool's **Slot**
window, and a Slot is *already* naive wall-clock (`date`/`start`/`end` strings,
per that schema's own exemption). A `timestamptz` placement checked against a
naive Slot would need a **venue timezone that this domain does not model**, and
keeping the two consistent would force migrating every Slot into the same frame.
Matching one representation beats introducing a second. (Modelling a tournament
timezone and moving both onto `timestamptz` is the more-correct long-term answer;
it is a larger decision than D1 needs, and is left open.)

An earlier draft split this into a bare time-of-day with the date inherited from
the pool's Slot. Rejected: the time is a real moment (a *prediction* is still an
instant, just a soft one), and the split forces date-inheritance at every read,
breaks on multi-day placements, and turns overlap detection into date arithmetic.

### The time is a prediction; constraints are flags, not invariants

The start time forecasts when a match will begin — a match starting off-prediction
is normal, not an error. The placement's rules (table belongs to the pool, time
inside the window, no table or player double-booked) are **not durable
invariants**: a pool's tables and window stay editable under a standing draw
(ADR-0786's mutable venue attributes), so a later edit can strand a placement
out-of-window or on a removed table. They are therefore judged as **flags derived
on read**, never a silent rewrite of a director's work, and the PATCH never
hard-blocks on them.

### Scope boundaries

- **D1 is model + a read-only, tournament-scoped Schedule grid.** The schedule is
  tournament-scoped, not per-event, because tables are shared across events — a
  same-table collision is a cross-event fact.
- **Deferred to the scheduler slice:** the CP-SAT auto-packer, the **pinned/free**
  distinction (its only consumer is the solver; D1's sole immovability rule —
  "a started match cannot move" — derives from `match_status`), a per-match
  **duration** estimate, and therefore meaningful **conflict flagging** (overlap
  needs durations, which do not exist — `length_games` is the only signal).
- **No new BFF:** placement rides the existing detail payload.

## Consequences

- A **re-cut** replaces fixtures wholesale (`delete-orphan`), and the
  account-merge un-cut path does too, so both silently discard placements. Re-cut
  is refused once there is evidence of *play*, but placements are not play — a
  director who places matches and then re-cuts loses them without warning.
- **D2** (the read-only spectator view) gets the schedule for free once these
  fields ride the detail payload. **D3**'s lifecycle e2e does not depend on this
  slice.
