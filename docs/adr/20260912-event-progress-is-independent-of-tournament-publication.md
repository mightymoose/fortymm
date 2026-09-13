# Event progress is independent of tournament publication

Status: Accepted for #1688, following the design interview. Part of #1669.

An event has its own sporting progress: `unstarted`, `in_progress`, `finished`,
or `cancelled`. Tournament publication remains the existing forward-only
`draft → published → live → archived` workflow. Going live still materializes
matches and requests scheduling, but does not assert that every event has played.
An unstarted event and an event underway can belong to the same live tournament.

## Start, finish and corrections

The first saved game score starts an event. The database preserves when play was
first recorded, separately from when play actually began. Today's score interface
records completed games, so the actual start time is unknown; neither a match
call nor the score's save time may masquerade as that actual start time. Clearing
or correcting a score never erases the first-recorded-play fact. Attaching older
recorded match history may refine that timestamp earlier, using only its retained
score evidence; clients cannot edit it, and transition observation history remains
unchanged. The earliest retained evidence determines the timestamp regardless of
attachment order. A provisional lineup captured at a match call retains its existing meaning and uncall exception;
it does not, by itself, start the event.

The existing per-draw results rules determine completion. When they become
complete, the event becomes `finished`; when corrections or voids make them
incomplete again, it returns to `in_progress`. Each transition increments a
dedicated lifecycle version and appends retained history. A subsequent finish
records a new transition rather than overwriting the earlier finish. Publication,
archival and an unrelated event's state do not determine these transitions.
Archiving does not prevent otherwise supported result corrections from changing
event progress. Results use the current draw; internal retirement of completed
draw history also reconciles progress without erasing earlier play or transitions.
Public draw replacement retains its existing refusal once play is recorded.

An event can move directly from `unstarted` to `finished` when valid results
establish completion without play, such as a future walkover-only event. It has
no first-recorded-play or actual-start timestamp. Reopening such an event follows
the same `finished → in_progress` rule without inventing play evidence. This
permits the state without enabling a walkover workflow or changing today's
draw-specific outcome rules.

Transition observation times and actual sporting occurrence times have distinct
meanings. Record exact occurrence times only when supported by evidence;
otherwise retain explicit unknowns. Seeded history follows the same rule, with
no guessed legacy start or finish times. Version order remains authoritative
even when timestamps are equal. Saved score creation times are immutable and cannot
claim a future observation.

An administrator void, a match transition into or out of a completed or voided
state, attaching, removing, replacing, or retiring such a match, or changing its
fixture result inputs must commit
with an explicit reconciliation assertion for each affected event's resulting
state and version. Deferred database guards reject these writes without a current
assertion. Each mutation retains its affected event before associations can
change; changing those inputs invalidates an earlier assertion in the same
transaction. Committed assertions are retained. Application writers use the
existing results strategy through `reconcile_event`; SQL maintenance must
reconcile and assert its result before committing. Active-entry changes in events
with progress require the same assertion, including SQL maintenance and account
merges. The database does not duplicate the draw strategies.

## Cancellation, archive and registration

Cancellation is an explicit terminal state, permitted before or during play.
It preserves prior progress and match records, blocks new game scoring and newly
attached completed or voided results, and allows correction of previously recorded scores and results under their existing
authority rules. Corrections never reopen a cancelled event. The internal backend
operation and database support do not add a public cancellation endpoint or UI.
Cancelled events are excluded from new match materialization, scheduling and calls;
their existing fixture topology, match, placement and call records remain retained,
even when no play was recorded.
If every event is cancelled, the tournament may still pass through live to archive;
the existing refusal for a truly empty tournament remains.

Archive records when a tournament was put away. It does not finish or cancel
unfinished events and does not rewrite their state or history. Cancelled events
and archived tournaments cannot be hard-deleted, even when no play occurred.
Archived tournaments also retain their unstarted events: those events cannot be
deleted or moved to another tournament. New events cannot be created or moved
into an archived tournament. Existing play, official-result and
advancement-history retention continues to apply. Lifecycle history itself cannot be rewritten or deleted.

Registration permission remains a separate policy. For compatibility, publishing
opens the tournament-wide entry and withdrawal window, and going live closes it,
including for events still unstarted. Cancelled events additionally refuse new
entries. This issue does not introduce independent event registration windows or
change existing idempotent withdrawal behavior. Successful entry and withdrawal
changes reconcile event progress because the active field can change Swiss
completion; re-entry can reopen a previously complete event.

## Amended decisions

This supersedes the identification of publication with sporting progress and
registration permission in
[the tournament-lifecycle ADR](0017-tournament-status-is-a-forward-only-lifecycle-with-guarded-edges.md).
Its public transition edges, guards and tournament-wide registration window
remain compatible. Archive no longer means every event has finished, and archived
tournaments cannot be deleted.

This supersedes the “event-completion is derived, never stored” and “no extra
hooks” clauses of
[the materialization/results ADR](0788-materialize-at-go-live-and-results-are-a-per-draw-type-strategy.md).
Results strategies remain the authority for completeness and computed standings;
persisted lifecycle state and transitions retain changes in that conclusion.
Manual archive and the existing completion/advancement behavior remain.

This extends retention in
[the fixture-history ADR](20260906-fixture-ownership-and-recorded-play.md)
to lifecycle history even without play. It does not redefine provisional lineups,
enable new result-correction permissions, or reconcile downstream advancement.

## Verification and migration

Use incremental behavioral tests through the existing scoring/results interfaces
and the internal lifecycle interface. Direct SQL is also an integrity interface:
exercise invalid states and chronology, terminal cancellation, immutable history,
version ordering and parent retention against an actual fresh Alembic install.
Representative scenarios include independent events, completion/reopening,
completion without play, cancellation and archive with unknown sporting times.

Rewrite the disposable pre-beta baseline under #1670's policy, preserving fresh
installation, schema parity and downgrade/reinstall checks. No legacy backfill,
populated-database upgrade path, public feature enablement or deployment belongs
to this change. Retention rules still apply to normal operations before cutover.
