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
advancement places the qualifier into that stage.

Stage withdrawal ends only that stage's participation. Event-wide competition
withdrawal ends all active participation and blocks further admission until
explicitly reversed. These are distinct from registration withdrawal and from
resolving a match. None automatically awards a walkover, changes a result or
rewrites recorded play. Missing a stage leaves later eligibility to that stage's
admission rules; no new late-admission workflow is enabled in this change.
Existing normal advancement remains supported.

Withdrawals record their effective time, acting Account, a category
(self-withdrawal, director removal or identity reconciliation) and an optional
explanation. Self-withdrawal explicitly names its Account; historical actors do not
follow Account merges. Normal stage completion and draw replacement are distinct
from withdrawal. Completion closes participation once all required fixtures are
resolved, including configured future Swiss rounds; it creates no withdrawal ban. Periods retain their start and end history rather than being
reactivated in place.

## Retained draw revisions

A cut creates an event-wide draw revision, including both stages when the event
has groups followed by a knockout. At most one revision is current. Re-cutting
retires the former revision and its participation periods, preserves its fixtures,
and creates a replacement atomically. Removing a draw retires the current revision
without deleting it; repeated removal remains idempotent.

Only the current revision contributes to the event's operational draw, standings,
scheduling, materialization and advancement. Historical stage and group references
must survive changes to the current draw configuration. Retained fixtures must not
prevent an otherwise supported configuration edit after removing an unplayed draw.
A refused replacement leaves the prior revision current and unchanged.

Removing a catalogue table referenced by a retired fixture retires the table from
the current catalogue rather than deleting its identity. Historical placements
keep their table reference. Current placements retain the existing explicit
unplace-or-refuse behavior; unreferenced removed tables may still be deleted.
The existing explicit deletion of an unplayed event or tournament remains supported.
The table foreign key uses deferred `NO ACTION`, preserving the reference at commit
while allowing whole-tournament cascades without modifying historical fixtures.

Retaining old draws does not authorize live redraws. Existing evidence-of-play
guards on cut and removal remain. This decision expands #1685 to preserve replaced
draw history; #1649 still owns new stale-draw messaging rather than this change
claiming to deliver its UI.

## Identity reconciliation

An Account transfer alone changes no sporting participation. When an explicit
same-person Player merge reveals duplicate entries, keep both entries and all
original membership, participation, fixture and lineup history. Permanently mark
the duplicate as superseded by the survivor, close its active registration and
participation with identity-reconciliation provenance, and resolve subsequent
registration to the survivor. A superseded entry cannot be reactivated.

If only one competing entry has recorded play, that entry survives regardless of
which Account remains. If both have recorded play in the same stage, refuse the
Player merge atomically and identify the conflicting entries for director
resolution; no resolution workflow is added here. A merge grants no new stage
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
