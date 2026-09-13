# Identities and sporting history survive deletion

Status: Accepted for #1690, following the design interview. Part of #1669.

## Identity lifecycles

Accounts and Players cannot be hard-deleted during normal operation, including
unused identities. Historical Account references continue to name the original
actor. Erasure must not turn a director-added entry into self-registration or
fabricate participant consent by clearing an actor reference.

Account deactivation disables authentication and action through that Account,
retaining its email and current grants and ownership. Reactivation restores the
same Account, subject to its current authority: revoked grants stay revoked and
transferred ownership stays transferred. Deactivation does not retire a Player,
withdraw an entry, transfer tournament ownership, or disable another manager.
An inactive owning Account retains its reference but cannot exercise authority.
Deactivation revokes outstanding session and email-confirmation credentials,
including merge confirmations targeting the Account. Confirmation endpoints
must recheck Account activity before changing identity or minting a session.
The database also revokes credentials on direct SQL deactivation and rejects new
credentials owned by or targeting an inactive Account. Reactivation cannot revive
old cookies or links. Existing linked login identities survive suspension, but SQL
cannot attach, reassign, or change a login credential while its Account is inactive.
Player-authorized writes hold the Account lock through the action so suspension
and admission have a deterministic order. A foreign login's guest reference grants no access to the
inactive guest and may remain so the active destination can still sign in.

Account erasure removes identifying Account data and credentials while retaining
an inert identity for historical attribution. It is distinct from reversible
deactivation and from an explicit same-person merge. An erased or merged Account
cannot use ordinary reactivation. A later sign-in using the same email does not
automatically reclaim the old Player, permissions, or ownership. Verified recovery
is a separate workflow. This decision does not establish a legal retention period
or claim that retaining an Account ID makes all related sporting data anonymous.
Player personal-data handling remains distinct from Account erasure. Database
validation covers credential child rows as well as Account columns, so direct SQL
cannot retain or attach login identities, tokens, or sign-in intents to an erased Account.

Player retirement is reversible and keeps the same identity, reserved username,
membership history, match results, and rating inputs. Retired and merged Players
are excluded from discovery, new-participant selection, active roster listings,
and current leaderboards. Historical results remain resolvable. Retirement alone
does not alter results or trigger a rating reset. Restoration applies normal
listing and leaderboard eligibility and does not re-enter withdrawn competitions
or recreate revoked access. Restoring a merged Player requires separate merge
reconciliation; it is not ordinary restoration. The event response separates the
visible `entrants` roster from `retained_entrants`, a lookup for hidden identities
referenced by fixtures and results. Clients resolve historical names through both
lists, preserve the server's derived `registration_order`, and use the server's
`entered` count for held registrations and capacity. Current-player membership and
withdrawal use both lists; hiding a roster row never cancels its held seat.
The server reports a `retired` entry refusal so withdrawing a held seat does not
make an ineligible Player appear able to enter again. SQL match-side admission also
locks the Player and refuses new retired participants, including insert-and-score
transactions. An already-held tournament seat may still materialize its exact
Player; unrelated seats do not grant admission.

The explicit Account/Player merge rules remain in force: retained attribution and
membership identify their original subjects, while current sporting identity
follows the canonical Player. Rebuildable rating projections remain separate from
immutable inputs and official-result evidence.

The [retention matrix](../retention-matrix.md) records the lifecycle policy and
the review of every foreign-key delete action.

## Sporting and aggregate retention

Only an unused draft tournament may be hard-deleted. Direct SQL cannot roll a
previously published tournament back to draft to evade retention. A registration, including a
withdrawn registration, protects its event and tournament even without play.
Every persisted table call, move, or cancellation protects its tournament,
including a pristine call cancelled before scoring. Recorded play, proposals,
official results, advancement evidence, event lifecycle history, cancellation,
and archive history also protect their required parent identities.

Deleting children first in one transaction cannot circumvent these rules.
Withdrawal, release, retirement, and archive express lifecycle changes rather
than deletion of the facts they close. A disposable draft's owned configuration
can be removed in one transaction without relying on cascade ordering. References
between owned rows use deferred `NO ACTION` where they must be checked against
the final transaction state. Cascades remain appropriate for genuinely disposable
owned configuration, credentials, delivery state, and rebuildable projections;
they are not a general history-retention strategy.

Standalone matches receive the same protection once a game score or result has
been recorded. Clearing the scratchpad, correcting a result, or voiding a match
does not make that match disposable again. Its identity and participant evidence
remain available. The first saved score or proposal captures immutable original
participant identities independently of editable current match sides, so merges
can reconcile those sides without deleting the original evidence. First evidence
requires valid participant topology; the established solo-match opponent sentinel
remains supported. Later writes cannot silently add missing original subjects;
same-person reconciliation and explicitly recorded lineup corrections remain valid.
Untouched standalone matches remain disposable.

Tables retain their separate reservation, outage, and catalogue lifecycles.
Releasing a reservation preserves its membership interval. A table with call
history is retired instead of deleted. Existing explicit removal of an uncalled
table remains possible subject to placement protection. Configuration referenced
by retained matches or evidence cannot be deleted; historical settings snapshots
are not rewritten by later configuration edits.

The current checkout represents team entrants through event Entries and member
intervals and represents a fixture with at most one linked Match. Retention applies
to those actual structures. This change does not introduce the separately scoped
reusable Team or multi-match Encounter features. Their future references must obey
the same retention rule when integrated.

## Scope and verification

Use database constraints and triggers plus the minimum compatible backend
operations and read filters. No new public lifecycle endpoints, lifecycle UI, deployments,
automatic identity verification, or competition eligibility policy is introduced.
A follow-up will let competition owners choose identity requirements, including
how to handle a new competitive identity after erasure. Retaining sporting inputs
alone does not prevent someone from creating another Player.

Implement in successive behavioral red–green slices. Direct SQL is a supported
integrity interface: verify identity, registration, table, result, match, and
parent deletion against the actual fresh Alembic schema, as well as lifecycle,
merge, login, listing, rating, and draft-cleanup backend behavior. Review every
foreign-key delete action against the retention matrix and verify metadata parity.
Rewrite the disposable pre-beta baseline under #1670's policy without legacy
backfills. Only explicitly identified disposable test databases may be reset;
normal-operation history protection also applies before beta cutover.

## Amended decisions

This extends [Accounts authorize durable Players](20260905-accounts-authorize-durable-players.md)
with deactivation, erasure, retirement, and restoration distinct from merges.
Referenced actor retention now also prohibits hard deletion of unused identities.

This supersedes the parent-deletion allowances in
[Entry members and lineup history](20260906-event-entries-have-members-and-match-lineups-have-history.md)
and [Fixture ownership and recorded play](20260906-fixture-ownership-and-recorded-play.md)
where registrations or cancelled pristine calls were previously disposable.
The guarded removal of a provisional lineup during uncall remains valid; it does
not erase the separate call history or restore tournament deletability.

This also supersedes the unplayed event/tournament deletion and quota-reclamation
allowances in [Registration outlives draw participation](20260911-registration-outlives-draw-participation.md)
once a registration exists. Retained registration periods, participation, withdrawals,
and replaced draw revisions keep their original subjects and actors. Storage limits
continue to refuse new allocations; they do not authorize history deletion.

This tightens the draft-cleanup allowance in
[Tournament authority](20260907-tournament-creator-owner-and-director-authority-are-separate.md)
and extends the parent retention in
[Table lifecycles](20260912-table-membership-outages-and-removal-have-separate-lifecycles.md)
to calls without play. The existing
[official-result](20260911-official-results-have-immutable-revisions.md),
[rating-input](20260911-rating-inputs-outlive-rebuildable-projections.md), and
[advancement](20260912-advancement-decisions-retain-their-result-evidence.md)
protections remain in force. [Event progress and archive history](20260912-event-progress-is-independent-of-tournament-publication.md)
retain their parent identities under the same matrix. Lifecycle transitions, recorded-game
evidence, cancellation and reconciliation receipts survive publication and archive changes.
