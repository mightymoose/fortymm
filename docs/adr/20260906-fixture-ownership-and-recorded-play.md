# Fixture ownership and recorded play

Status: Accepted for #1677, on the entry-members model in #1672.

## Scope

This implementation deliberately excludes #1673 and #1674, as agreed in the
follow-up implementation request. It uses the existing one-match fixture model.
Reusable teams, encounter slots and encounter scoring snapshots are not introduced.
A future team-encounter change must replace this cardinality deliberately.
There are no new HTTP/MCP contracts, screens, rating policies or deployments.

## Ownership and contestants

A fixture belongs to a stage and one of that stage's groups. Its contestants must
be entries in that same event. Both populated contestants must differ. A winner
requires both contestants to be known and must name one of them. A missing side
still means TBD; byes remain the absence of a fixture row.

`scope_event_id` and `scope_tournament_id` are stored solely as composite foreign-key
carriers. The database fills omitted values from the stage/event and checks every
link. Existing callers still supply the stage, and `fixture.event_id` remains the
existing stage-derived Python property. Explicit contradictory scope values fail;
the scope columns cannot be used to move a played fixture indirectly.

A placed table must belong to the fixture's tournament. Reservation membership,
windows and scheduling conflicts remain derived concerns. Removing a table from
its reservation pool does not invalidate a historical placement. The existing
reference to the real table and its removal refusal remain.

The match reference has a unique index: one fixture can hold one match and one
match can belong to at most one fixture. Unattached standalone matches remain
valid. Standalone unrated solo matches keep their playerless second side; none of
these contestant constraints apply to them.

Withdrawal does not invalidate an entry's contestant or winner references. A
walkover can name either known contestant as winner without attaching a played
match. This permits the database state without adding a walkover workflow or
changing rating/advancement behavior.

## Recorded play

#1672's lineup history records which entry members actually played. Once that
history exists, the fixture's identity, draw position, stage, group, event,
tournament, contestants and match attachment cannot change. Deleting the fixture
is also refused. Changing a match's terminal status does not erase this evidence.
The merged #1672 pristine-uncall exception remains: undoing a call before any games
or results exist removes its provisional lineup and leaves the fixture editable.
Scores and outcomes can still be corrected, including director-attributed lineup
correction revisions under #1672's existing rules.

Structural fixture writes extend #1672's existing parent-lock discipline to all
ownership fields. A concurrent detach cannot orphan recorded play: writers entering
with a fixture lock must retry on SQLSTATE 40001 when the parent is busy, rather
than waiting backwards and deadlocking a match start. Existing attachment-time
lineup capture and validation remain, so attachment cannot bypass entry-member
checks or miss a concurrent start. Standalone matches acquire no tournament lineup
until attached. Captured membership is independent of later roster changes.

Foreign keys preserve the parent chain as well: moving the stage to another event,
the group to another stage, or the event to another tournament cannot silently
move a played fixture. Before play, valid fixture changes remain possible.

## Migration and verification

The disposable pre-beta baseline is rewritten; there is no legacy-data backfill.
The baseline carries frozen SQL definitions independently of the ORM hooks.
Direct SQL tests run against both ORM DDL and fresh Alembic installs, including
staged concurrent starts/attachment changes, explicit NULL cases, withdrawn entries
and legitimate historical placements. Fresh-install schema parity and backend
regressions remain required. Only task-owned test databases are created/reset.

## Superseded clauses

This amends ADR 20260815 decision 5's rejection of stored event ownership on a
fixture: the stage remains its domain parent, with redundant scope columns now
required for enforceable composite foreign keys. The public/read interface stays
stage-based.

It also tightens the August 1 placement ADR's "real table" invariant to require
the same tournament. Reservation-pool membership and other scheduling flags remain
soft. ADR-0786/0788's separation of fixture and match, TBD sides, absent byes and
singles public behavior remain. This extends #1672's history retention to fixture
ownership and closes attachment-time lineup validation.
