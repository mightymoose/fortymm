# Registration outlives draw participation

Status: Accepted for #1685 after the design interview.

## Durable entry and registration

An entry identifies a competing unit in one event. Withdrawing and re-entering
preserves its ID and membership history. Registration is recorded in periods:
withdrawal closes the current period; re-entry opens another on the same entry.
A returning entrant takes its new registration time in draw ordering. Identity
reconciliation preserves the earlier applicable registration priority without
rewriting either original period; a later return starts fresh.
The existing registration window, eligibility, capacity and authorization rules
continue to apply. Public singles entry and withdrawal keep their existing
interfaces; this does not enable doubles registration or director overrides.

Registration withdrawal atomically ends competition participation throughout the
event. It preserves entries, members, fixtures and actual match lineups. Re-entry
restores registration but does not revive any previous draw seat. Before play,
the director must explicitly re-cut the draw to admit the returning entry.
Draw currency must therefore distinguish participation periods, not merely compare
entry IDs: the same field of IDs can have withdrawn and returned since a cut.

## Participation and withdrawal

A participation period belongs to an entry, its event, a stage and that stage's
group. An entry may have at most one active participation period per stage,
including across groups, while participating in several stages. Changing groups
ends the former period and creates another; historical fixtures retain their
original references. A bye does not mean absence from the stage's field.

Each known fixture contestant references the participation period that earned its
seat as well as its durable entry. An ended participation remains a valid historical
contestant or winner. Empty future fixtures confer no participation: in a
group-to-knockout draw, normal qualification creates knockout participation when
advancement places the qualifier into that stage. Advancement checks eligibility
before applying a fixture-side fill or recording its decision, so an ineligible
qualifier cannot roll back the result that completed the preceding stage.

Swiss advancement and completion use the active participation field of the
current stage and draw revision, including admitted byes. Registration alone does
not add an entrant to later rounds.

Stage withdrawal ends only that stage's participation. Event-wide competition
withdrawal ends all active participation and blocks further admission until
explicitly reversed. These are distinct from registration withdrawal and from
resolving a match. None automatically awards a walkover, changes a result or
rewrites recorded play. Missing a stage leaves later eligibility to that stage's
admission rules; no new late-admission workflow is enabled in this change.
Existing normal advancement remains supported. Initial draw fields exclude entries
with an unrestored event-wide competition withdrawal, even when their registration
remains current.

Entry status and recorded registration periods agree at commit: a withdrawn or
superseded entry has no current registration or participation, and an entered
entry with registration history has a current registration.

At commit, an unrestored withdrawal cannot coexist with an open participation
period in its scope. Deferred validation permits the normal insert-then-close
transaction while enforcing the same rule for direct SQL writers.

Withdrawals record their effective time, acting Account, a category
(self-withdrawal, director removal or identity reconciliation) and an optional
explanation. Self-withdrawal explicitly names its Account; historical actors do not
follow Account merges. Normal stage completion and draw replacement are distinct
from withdrawal. Completion closes participation once all required fixtures are
resolved, including configured future Swiss rounds; it creates no withdrawal ban. Periods retain their start and end history rather than being
reactivated in place. Interval endpoints use PostgreSQL time, matching their
server-generated starts even when an API host clock is behind.

## Retained draw revisions

A cut creates an event-wide draw revision, including both stages when the event
has groups followed by a knockout. At most one revision is current. Re-cutting
retires the former revision and its participation periods, preserves its fixtures,
and creates a replacement atomically. Removing a draw retires the current revision
without deleting it; repeated removal remains idempotent. Once no current draw
remains, removal returns after authority and ownership checks without scanning or
rewriting archived fixtures.

Only the current revision contributes to the event's operational draw, standings,
scheduling, materialization and advancement. Historical stage and group references
must survive changes to the current draw configuration. Fixture retirement agrees
with both its revision and stage; an archived fixture cannot retain a mutable
current stage. Retired stage, group and
table metadata cannot be rewritten or reactivated. Direct changes to archived
group mappings are refused; supported removal of a live reservation may cascade
its link away because the immutable revision snapshot retains the cut-time mapping
and reservation values. Retained fixtures must not
prevent an otherwise supported configuration edit after removing an unplayed draw.
Draw cuts allocate participation periods once and supply their identities to each
fixture. Insert statements validate their fixture seats as a batch. Fixture
insert, update and delete statements lock distinct parent events once per batch,
including both old and new parents when a fixture moves. Direct SQL retains automatic seating when period identities are
omitted; updates and deletes retain their row guards.

Deferred retirement validation checks changed fixtures and participation periods
by identity; stage/revision changes check their own dependent rows. It does not
rescan a whole event for every inserted fixture. Validation reads final stored
state, including after repeated changes within one transaction.
Quota checks run against the prospective plan and configuration before any draw
retirement. Group identities are bound after accepted configuration materialization;
UUID replacement preserves the checked snapshot byte size.

Advancement decisions retain their source and destination fixtures under the
September 12 advancement-provenance decision. Cut and parent-deletion guards
include archived draws when checking that retained evidence. Historical play
lookups use an index containing only fixtures with match/winner evidence;
advancement decisions carry a database-checked event key for indexed event-scoped
lookups. Negative history checks do not scan all retained fixtures.

A refused replacement leaves the prior revision current and unchanged. Retirement
changes only the retirement marker; other fixture fields remain as last recorded.

Removing a catalogue table referenced by a retired fixture retires the table from
the current catalogue rather than deleting its identity. Historical placements
keep their table reference. Deleting the last event that references a retired
table reclaims that otherwise unreachable catalogue row. Current placements retain the existing explicit
unplace-or-refuse behavior; unreferenced removed tables may still be deleted.
The existing explicit deletion of an unplayed event or tournament remains supported.
The table foreign key uses deferred `NO ACTION`, preserving the reference at commit
while allowing whole-tournament cascades without modifying historical fixtures.

Retaining old draws does not authorize live redraws. Existing evidence-of-play
guards on cut and removal remain. This decision expands #1685 to preserve replaced
draw history; #1649 still owns new stale-draw messaging rather than this change
claiming to deliver its UI.

## Retained storage bounds

Retained history makes repeated unplayed cuts a storage allocation, so director
authority alone is insufficient. HTTP and MCP share hard limits: 150,000 fixtures
per cut; 250,000 retained fixtures and 32 revisions per tournament; and 500,000
retained fixtures and 128 revisions attributable to one Account across tournaments.
Each retained configuration snapshot is also limited to 64 KiB of encoded JSON,
so the revision limits bound retained configuration to 2 MiB per tournament and
8 MiB per acting Account. Fixture counts alone cannot bound arbitrary text values. Reservation writes limit
names to 255 characters; existing names remain readable.
Both current and retired revisions count. A full 512-entry round robin still fits
one cut. A refused allocation preserves the standing draw and reports an actionable
error. Existing explicit deletion of unplayed events and tournaments can release
storage; reaching a limit never deletes history automatically.

Each externally requested revision records its original acting Account, which does
not change on ownership transfer or identity reconciliation. Account allocation is
serialized before acquiring the tournament lock, so simultaneous requests against
different tournaments cannot overrun the Account budget. A concurrent cut by the
same Account fails promptly instead of waiting on the actor lock while retaining a
request database connection. Enforcement uses retained
PostgreSQL state and does not depend on a fail-open Redis rate limiter. Each draw
revision stores a fixture total maintained transactionally by PostgreSQL statement
triggers. Quota checks read bounded revision totals rather than scanning retained
fixtures, so repeated refusals do not become more expensive as fixture history
grows. Inserts, moves, deletes, and parent cascades maintain those totals; direct
SQL cannot overwrite them. Counter-only updates do not revalidate the revision’s
retired fixture graph.

Explicit re-cuts remain supported even for apparently identical fields: withdrawal
and re-entry can require new participation while preserving the same entry IDs.
The hard allocation limits bound repeated calls without silently deduplicating
sporting history. These bounds constrain storage amplification by one Account;
they are not a substitute for deployment capacity monitoring or account admission.

## Identity reconciliation

An Account transfer alone changes no sporting participation. When an explicit
same-person Player merge reveals duplicate entries, keep both entries and all
original membership, participation, fixture and lineup history. Permanently mark
the duplicate as superseded by the survivor, close its active registration and
participation with identity-reconciliation provenance, and resolve subsequent
registration to the survivor. A superseded entry cannot be reactivated.

If only one competing entry has recorded play, that entry survives regardless of
which Account remains. If that survivor is withdrawn and the duplicate is
registered, reconciliation preserves active registration on the survivor through a
new registration period. If the active duplicate is eligible for the event, the
survivor also regains event eligibility, recording restoration on its withdrawal
history. This does not revive ended participation or override stage withdrawals. If both have
recorded play in the same stage, refuse the
Player merge atomically and identify the conflicting entries for director
resolution; no resolution workflow is added here. Conflict lookups use indexed
fixture-side evidence within the colliding events, including archived play.
Confirmation credentials remain recoverable after a merge conflict, but repeated
attempts are bounded before taking account or tournament locks: live merge
credentials allow one in-flight attempt and five attempts per hour. Concurrent or
exhausted attempts return 429; unavailable retry-budget storage returns 503 with
retry guidance. An expiring Redis counter survives database rollback. Invalid and
ordinary confirmation links allocate no counter and retain their existing behavior. A merge grants no new stage
admission. Event-format rules still determine whether multiple entries are actually
duplicates; the explicit team-event exception remains.

## Superseded decisions

- ADR-0016's new entry row on return is replaced by durable entries and registration
  periods. Counts remain derived; withdrawal still preserves history.
- ADR-0786's deletion of an old draw on re-cut or removal is replaced by retained
  revisions. Explicit cuts, deterministic planning and guarded advancement remain.
- The September 6 entry-members ADR's duplicate-withdrawal rule gains permanent
  supersession, played-entry precedence and same-stage played-history refusal.
  Membership and actual lineup retention remain unchanged.
- The September 6 fixture-ownership ADR's permission to delete unplayed fixtures
  does not apply to retiring a retained draw. Its scope and recorded-play integrity
  rules continue to apply to historical contestants.
- The August 1 placement ADR's physical catalogue-row removal gains the historical
  reference exception above. A historical placement still names a real table.

## Verification and migration

Use TDD through existing registration, draw and merge interfaces, adding one
behavioral regression and making it pass before the next. The database is also an
explicit interface for this issue: direct SQL must reject contradictory scopes,
duplicate active participation and history erasure while admitting ended historical
contestants. Exercise withdrawn/re-entered and reconciled guest scenarios.

Rewrite the disposable pre-beta baseline without legacy backfills. Verify actual
fresh Alembic installs, schema parity and backend regressions. Only task-owned
test databases may be reset; this change performs no deployment or shared-data reset.
