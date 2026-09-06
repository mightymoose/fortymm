# Event entries have members; actual match lineups have history

Status: Accepted for #1672, building on the Account/Player separation in #1671.

## Scope

Database structure and integrity tests, a reset-compatible pre-beta baseline, and
the minimum adaptation needed to keep existing singles behavior. No new UI,
HTTP/MCP endpoints, doubles/team registration, substitution or correction workflow,
payment model, organization model, or deployment is introduced.

## Entries and membership

An **Entry** is the competing unit in one event. Its ID, seed, draw position and
results survive replacement of any or all members. An **Entry member** is a
Player's membership interval: joining and leaving are recorded separately, and
ending membership does not replace or erase its original Player, entry or join
time. A returning member gets another interval. Entries remain soft-withdrawn;
the active entry count is derived from entries, not from the number of members.
Intervals for the same entry and original Player cannot overlap. Departure is an
exclusive boundary, so a returning interval may begin exactly at that instant.

At transaction completion an active singles entry has one current member, a
doubles entry has two, and a team entry has at least one. Replacing a doubles
partner closes one interval and adds another atomically. The database rejects
duplicate current members within an entry, including identities joined by a Player
merge. The team exception never permits duplicate members within one entry.
Scoped participation rules are:

| Event format | Active participation per Player in this event |
| --- | --- |
| Singles | One entry |
| Doubles | One pairing |
| Teams | One entry by default; the stored event rule may explicitly allow more |

A Player can enter several events in the same tournament. Withdrawal or ending a
membership frees their place for another entry in that event. The team exception
cannot be enabled on singles or doubles events. These rules are enforced for SQL
writers as well as the backend: writes serialize on the event row, with deferred
checks allowing a replacement to be completed within one transaction.
Format edits lock that event before validating the roster, so a racing member edit
produces the existing format conflict rather than a commit-time server error.

After the tournament goes live, changes to existing entry membership must record
the current director's Account as the joining/leaving actor. Initial entry/member
construction in one transaction remains possible for seeds and model construction.
An inserted closed interval must attribute both joining and departure. Roster
writers hold a shared tournament lock before authorization and event locking,
serializing with go-live's status write and materialization.
The database stamps and preserves the entry's creation transaction ID; an older
transaction does not become its creator merely because its timestamp is earlier.
This is attribution and domain validation for trusted database writers, not a new
authentication mechanism: any future workflow must authenticate its actor. Today's
public registration window stays closed after go-live, including for directors.

## Scheduled participants and actual lineups

`match_side_players` continues to serve today's scheduled participants and singles
contracts. At the first persisted transition to `in_progress`, a tournament match
captures those participants into a separate **Match lineup** and its member rows.
An ordinary result that completes a pending match directly captures the lineup at
completion, the first recorded evidence of play when no start signal was saved.
An explicit walkover remains lineup-free.
Assigning an already-started match to a fixture also runs capture and eligibility
validation, recording its participants when it first becomes tournament play.
A match belongs to at most one fixture; unmaterialized fixtures may share a null
match reference. A fixture's two non-null seats must name distinct entries: a
competing unit cannot play itself. Match status writes lock the parent tournament
before the event, before deferred capture, so deletion cannot remove the fixture
in between.
Direct fixture-link writers must use tournament-before-event-before-fixture lock
order. The row trigger takes available parent locks without waiting; if another
transaction already holds one, it raises retryable SQLSTATE `40001` rather than
waiting backwards after the fixture row lock. Retry the transaction with a shared
tournament lock and an exclusive event lock acquired before updating the fixture.
A fixture with a lineup, game, or result cannot be unlinked, linked to another
match, reseated, moved to another stage, or deleted; the recorded association remains
available to deletion guards. Unplayed fixtures can still advance or be reseated.
Direct database writes cannot create an initial played lineup for a pending match;
the match must be in progress or have a played terminal outcome.
Automatic capture and direct lineup validation acquire the roster's event lock
before checking member eligibility, so a concurrent replacement cannot leave a
committed lineup outside its member's recorded interval.
Direct headers take this lock immediately, before participant foreign keys acquire
member locks, matching deletion's event-before-member ordering.
Every participant must be a current member of the entry seated on their side.
Both seated entries must belong to the fixture stage's event before a lineup can
be recorded, including snapshots supplied directly by database writers.
Team rosters may be larger than the actual lineup; `MatchSettings.team_size`
determines the number playing on each side.

An event or tournament containing recorded play cannot be deleted. Historical
membership references block cascading deletion in the database; the existing
HTTP delete actions return a 409 refusal and MCP delete tools report the same
reason. Owner/not-found checks still run first. Unplayed events remain deletable;
this adds no deletion UI or alternative deletion workflow.

Deletion locks the event and membership rows before checking history. A concurrent
first lineup holds membership foreign-key locks, so deletion waits and then reports
the recorded-play refusal rather than leaking a foreign-key error. The event-first
lock order also prevents roster changes from invalidating that check.
Game and result rows also prevent deletion when a pending match has no lineup yet;
their insertion serializes with the deletion guard on the event.
If deletion wins that race, a writer that had resolved the tournament association
must abort with retryable SQLSTATE `40001` when its event lock finds no surviving
row. Existing game and result records cannot be reassigned to another match.
After obtaining the event lock, evidence and status writers recheck the original
fixture association. A concurrent unlink, replacement, or move to another event
requires a retry rather than committing against a stale association.

Direct membership updates follow the same parent-first locking contract as fixture
updates, as do entry status updates. Since a row trigger already holds the child
tuple, it refuses contested
tournament or event locks with SQLSTATE `40001`; the writer retries with tournament
and event locks acquired before the child update. This avoids deadlocking
against deletion, which locks parents before membership rows.
Standalone entry deletion is forbidden while its event remains: withdraw the entry
instead, retaining all membership intervals and fixture references. An unplayed
event or tournament deletion may still cascade through its entries.

The snapshot references the original entry membership and Player. Later roster
changes and sign-in reconciliation cannot rewrite it. Before starting a match,
a database writer can amend its scheduled participants to reflect an eligible
replacement. No such scheduling or substitution workflow is exposed here. An
existing match call is the backend's start signal; subsequent call corrections
do not rewrite an already recorded lineup.

A call is provisional until a score or result is recorded. The existing director
action that cancels an untouched call returns the match from `in_progress` to
`pending` and clears its provisional lineup in the same transaction. A later call
captures the then-current participants; the cancelled call is not recorded play
and does not prevent event deletion. Any game or result keeps the lineup and
deletion protection intact. Only this guarded un-call transition can clear a
provisional snapshot; direct lineup deletion remains forbidden. No UI is added.
Cancellation also validates the final transaction state: later game or result
inserts cannot commit after the same transaction discarded their lineup.

Membership joins use wall-clock insertion time, not transaction-start time, so a
long-running roster transaction cannot backdate a replacement's eligibility.
Format edits incompatible with current member counts or the team's participation
exception are refused by the existing HTTP/MCP adapters before mutation; database
constraints remain the final guard for direct writers.

A **Lineup correction** is another complete revision, with the same start time,
the next revision number, the current director's Account, and a nonblank reason.
The earlier revisions and their actors remain stored. Every corrected participant
must belong to the corresponding entry at the recorded match start. Reads of the
new history can select the highest revision for the corrected account and retain
earlier revisions for audit. Existing UI/read contracts are not switched to a new
correction feature by this change.

Each revision stores its full creating transaction ID. Participants can be added
only within that transaction, including its savepoints; committed revisions remain
immutable even after PostgreSQL discards old transaction-status information,
except for the explicitly provisional, untouched-call cancellation above.
Every revision's start time must be at or before its recorded time.

The database can record `matches.ending = walkover` without an actual lineup, or
`stopped_during_play` with one. Both are terminal outcomes; the fixture can retain
the advancing entry. `NULL` preserves ordinary result negotiation. The latter name
avoids overloading **Retirement**, which already means automatic acceptance of an
unanswered standing result. This does not expose special-result submission or
implement new rating, standings or advancement policies for those outcomes.
Walkovers cannot contain game or result records either; validation covers both
evidence written before the ending and evidence added afterward.
Clearing a completed walkover's ending to ordinary completion captures its lineup
even when the status itself is unchanged.

## Identity reconciliation and compatibility

The stored `tournament_entries.user_id` column is removed. Existing singles callers
retain a derived `user_id`, resolved from their one current member. The constructor
compatibility path creates that member row. Multiple-member entries have no singles
projection and remain outside today's public registration/materialization flows.

An explicit same-person Player merge leaves each membership's originally recorded
Player intact. Its current singles projection follows the Player's merge chain;
authentication still relies on AccountPlayer grants, never on matching UUIDs.
Historical lineup participants remain the originally recorded identities. If two
active singles entries collide, the losing entry is withdrawn, not erased. Existing
seed/order reconciliation and uncut/re-solve rules continue. An Account transfer
alone changes neither membership nor actual participants.
Distinct entries in a team event that explicitly allows multiple entries per
Player are not collisions and remain entered through an identity merge.
Merge membership locks and duplicate checks are scoped to events containing the
source Player or its earlier merged aliases, not unrelated platform entries.
Collision discovery starts from indexed memberships for both merging identities
and their aliases, then reuses the candidate entry IDs for reconciliation.
If registration commits between collision discovery and the Player update, the
merge retries its sporting reconciliation within a savepoint, at most three times.
The post-update check stays scoped to the merged identities and does not force
unrelated deferred constraints. Historical Account names survive that retry.
Before reconciling match sides, a merge locks the tournaments containing either
identity's memberships in stable order, even when their entries do not collide.
Go-live therefore finishes materialization before reconciliation or waits for it,
instead of crossing the merge's event locks with its own tournament lock.

## Migration and verification

The pre-beta baseline is rewritten for fresh installs. No legacy backfill or
populated-database upgrade path is provided. No shared/deployed database is reset.
After #1670 freezes the baseline, changes require forward, preserving migrations.

SQL constraint definitions are registered with ORM DDL and frozen independently in
the self-contained baseline. The new integrity scenarios run against both schema
paths, and the migration parity test compares an actual fresh install to metadata.
The baseline also supports an upgrade/downgrade/upgrade round trip.
Existing singles entry, draw, match, sign-in and read regressions remain required.

## Superseded clauses

This supersedes ADR-0016's stored single-user entry and partial event/user index,
ADR-0786's deletion of a duplicate entry during identity merge, and the corresponding
entry-repoint clause of the September 5 Account/Player ADR. Soft withdrawal,
derived counts, existing authorization and registration behavior remain in force.

ADR-0788's absent partner model is superseded at the database level. Its public
singles-only restriction remains. Its statement that results are derived live
continues to apply to standings and outcomes; actual participants now have their
own preserved history. ADR-0784's current director-entry workflow remains unchanged.
