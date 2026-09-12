# Tournament creator, owner and director authority are separate

[Identity and sporting retention](20260912-identities-and-sporting-history-survive-deletion.md) limits whole-tournament cleanup to unused drafts and defines inactive ownership without transferring authority. Existing grants survive deactivation but cannot authorize the inactive Account.

Status: Accepted for #1681, following the design interview. Part of #1669;
the disposable pre-beta baseline freezes at #1670.

## Decision

A tournament's original creator is historical Account attribution, immutable even
after an ownership transfer or account merge. Each tournament has exactly one
current owning Account, initially its creator. Attribution alone grants no access.
The existing creator column and public field may retain their legacy
`created_by_user_id` spelling; they reference Account, not Player.

Tournament-scoped Account grants carry an explicit role. Only `director` is
supported in this change. Umpire roles, match assignments, organizations and billing
are deferred. Account and tournament relationships have real foreign keys; there is
no polymorphic owner identifier.

An owner can perform tournament operations, transfer ownership, grant or revoke
director authority, and delete an otherwise deletable tournament. A director can
perform tournament operations, including entries, event settings, draws, tables,
scheduling, publication transitions and results. Directors cannot transfer ownership,
manage grants or delete the tournament. Sporting eligibility, registration windows,
recorded-play protections and other domain rules still apply.

Active guest Accounts qualify as owners and directors, as do active claimed
Accounts. A primary Player or confirmed email is not a prerequisite for tournament
authority. Tombstoned Accounts cannot receive or exercise authority.

## Transfers, revocation and merges

An owner-initiated transfer takes effect immediately, without recipient acceptance.
Existing director grants survive. The former owner loses ownership authority and
receives no automatic director grant; an independently held grant remains valid.
Creation also creates no redundant director grant.

Grants retain their original recipient, grantor and time. Revocation records its
actor and time rather than deleting the grant. Regranting creates a new historical
interval. Duplicate active grants for one tournament, Account and role are forbidden.
Ownership transfers record previous owner, new owner, actor and time. Provenance
distinguishes an explicit action from an account merge; no free-text explanation
is required. A system-applied merge has no invented human actor; its reason and
source Account or grant identify the inherited authority. This is authority
history, not a general audit log of tournament edits.
Existing privileged actions keep their original actor attribution.

New tournament matches are attributed to the current owner when the system
materializes them. Ownership transfers never rewrite the creator of an existing
match. Explicit result actions continue to name their actual acting Account.

An ownership change is applied by inserting its immutable transfer record. The
database advances a tournament-local ownership revision and changes the owner
atomically; direct owner updates without the corresponding new transfer are
rejected. Earlier transfers cannot be replayed to authorize another change.

The existing same-person account merge carries ownership and active director
authority to the surviving Account. It ends source grants, preserves their history,
and consolidates overlapping authority into one active grant. A merge must not
pretend that the tournament owner newly delegated authority or rewrite historical
creators, grantors, revokers or action actors.

An inherited grant starts at the same database instant its source grant ends.
Authority timestamps come from the database clock after acquiring the relevant
locks, rather than combining application time with transaction-start defaults.

Authority changes and privileged writes have a definite transactional order. An
action completed before revocation or transfer stands. An action ordered after an
authority change must pass authorization against the changed authority. Account
merges participate in the same protocol; checking authority before waiting for a
lock is insufficient.

## Retention and compatibility

Authority history survives while its tournament survives. Existing tournament
deletion remains available when the recorded-play guard permits it, and deleting
that tournament also deletes its grants and transfer history. Historical Account
references restrict Account deletion; merging tombstones the Account instead.

Grant management and ownership transfer are internal backend interfaces exercised
by tests. This issue adds no public management endpoints, UI, invitations or
notifications. Ordinary creator-as-owner workflows remain compatible. In particular,
the existing tournament `can_edit` UI field remains owner-only because current
clients also use it to offer tournament deletion. Delegated tournament UI and
separate per-action UI capabilities are deferred; the backend's operational
authorization is distinct from that compatibility field.

## Amended decisions

This supersedes the owner-only operational authorization clauses of
[ADR-0784](0784-director-entry-is-the-same-endpoint-gated-by-ownership.md): a director
grant also authorizes entry and withdrawal on another Player's behalf. Its shared
eligibility, capacity and registration-window rules remain in force.

This supersedes the statement in
[ADR-0015](0015-read-only-is-a-view-not-a-disabled-form.md) that every tournament
mutation must reject every non-owner. Its presentation rules remain in force;
the current owner UI is preserved as described above.

This extends [Accounts authorize durable Players](20260905-accounts-authorize-durable-players.md)
with retained director-grant and ownership-transfer provenance during merges. Its
separation of Account actors from Player participation and its preservation of
historical actors remain in force.

## Verification

Use incremental red-to-green tests through the internal authority interface and
existing backend operations for transfer, delegation, refusal, revocation, guest
merges and deletion. Stage lock contention to prove the ordering rule. Independently
exercise the database contract with direct SQL negative tests against actual fresh
Alembic installs, including creator immutability, foreign keys, active uniqueness,
history protection and schema parity. Seed creator-as-owner tournaments without
unintended grants. No legacy populated-database upgrade or shared-environment reset
is needed; this change follows the pre-beta migration policy.
