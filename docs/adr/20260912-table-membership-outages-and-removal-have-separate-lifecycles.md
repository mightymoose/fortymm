# Table membership, outages, and removal have separate lifecycles

[Identity and sporting retention](20260912-identities-and-sporting-history-survive-deletion.md) makes call history immutable and prevents deleting its tournament, including when a call was cancelled before play.

Date: 2026-09-12 (date-numbered — sequential numbers collide across concurrent
worktrees; see `scripts/check-adr-numbering.sh`)

## Status

Accepted. Amends [“A placement names a real table, and only that is an
invariant”](20260801-a-placement-names-a-real-table-and-only-that-is-an-invariant.md)
and [“A called match holds its time, and a clashing call is
refused”](20260902-a-called-match-holds-its-time-and-a-clashing-call-is-refused.md)
for table availability and identity retention.

## Context

A table has a stable identity in the tournament venue catalogue. Reservation
membership, service availability, and a fixture's placement are different facts:
releasing a reservation, marking a table unavailable, and removing a table from the
catalogue must not erase one another's history or rewrite a match's identity.

`pinned_at` is current scheduling state. It may be cleared when a placement is
cancelled, so it cannot answer whether a table was ever used for a called match.
Likewise, the current reservation `table_ids` cannot answer whether a table was held
there in the past.

## Decision

**Reservation membership is temporal.** Releasing a table closes the active membership
period; adding it again opens a new period with the same table id. Reads expose only
active periods. A release never deletes the venue table and never clears a fixture's
placement.

**An outage is a table-wide interval.** It belongs to the tournament's table identity,
applies across every event and reservation, and records only the time it began and,
when restored, the time it ended. An outage leaves reservation memberships and fixture
placements untouched. During the interval the scheduler treats the table as occupied
for new placements; existing calls remain fixed promises. A table has no outage record
when it is available, so availability is the absence of an overlapping outage for an
actively reserved table.

**Catalogue removal is an explicit user action.** A removed table with no call history
may be hard-deleted, subject to the existing placement guard and opt-in. If any call,
move, or cancellation has referenced the table, removal retires the table instead:
remove it from active catalogue reads, close its active reservation memberships, and
retain its identity and call history. The application never removes a table merely
because it has no reservation or is out of service.

**Call history is separate from the pin.** Each call, move, and cancellation transition
records the table id and scheduled start it referred to. `pinned_at` continues to
describe the current solver promise; history is append-only and is the evidence used to
choose retirement over deletion. Removal reasons are not recorded.

## Consequences

Reservation membership rows have an identity and effective interval. A partial unique
index allows one active row for a reservation/table pair while preserving closed
periods. Outages use the same interval convention, scoped by the composite
`(tournament_id, table_id)` key, with at most one active outage per table.

The scheduler snapshot carries outage intervals as fixed table obstacles, merging them
with other fixed table occupancy so an outage overlapping a called match cannot make a
solve infeasible. The schedule preview uses the same table availability input.

The pre-beta Alembic baseline remains the schema source of truth. No wire shape,
removal-reason field, or new screen is part of this decision.
