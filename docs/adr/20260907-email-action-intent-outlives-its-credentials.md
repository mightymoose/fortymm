# Email action intent outlives its credentials

Status: Accepted. Issue [#1679](https://github.com/mightymoose/fortymm/issues/1679).

## Decision

Separate session credentials from email-link credentials. An email credential has
a constrained purpose and typed action fields, never an encoded context string.
Supported purposes cover ordinary sign-in, first sign-in, email change (including
the first confirmed address), and guest-to-account merge confirmation. Prior-email
snapshots support the full validated 254-character address. Account owners, merge
targets and recorded guest sources reference Accounts through real foreign keys;
database checks reject fields inappropriate to a purpose.

Pending intent and bearer credentials have different lifetimes. A pending email
change retains its requested address and original action until completion,
replacement or invalidation. A first-sign-in intent retains the association
between the requested address and its unconfirmed Account. Both survive link
expiry, credential cleanup and clicks on expired links. Expiry alone does not
remove the ability to request another link.

There is one pending first-sign-in Account per normalized email, enforced by the
database. Concurrent requests reuse that Account. Each new sign-in request binds
its own requesting guest, preserving cross-device merge behavior without carrying
an earlier request's guest into a later request.

Revalidate intent at resend and confirmation. If the prior address changed, the
requested address became unavailable, or a merge destination no longer qualifies,
clear the invalid intent and require a fresh request. Resend must not reinterpret
an email change as a merge, redirect a merge to another Account, or send another
credential for an impossible action. Pending intent does not reserve an email
against another supported flow claiming it.

Serialize issuance, replacement, resend and consumption for the affected action.
If confirmation wins, resend cannot revive the completed action. If replacement
wins, the old credential cannot complete it. Concurrent first-sign-in requests
cannot create separate pending Accounts for the same normalized address.
After rollback, reacquire the Account lock and verify the failed credential is
still current before clearing its action; cleanup cannot erase a newer request.

## Retention and compatibility

Delete completed, superseded and invalidated intent rather than retaining an audit
ledger. Keep only the old-credential metadata needed to explain that a newer link
was requested. That explanation remains valid only while the old link has not
expired and a usable replacement exists. Remove the metadata once it can no
longer support that response. Prior addresses and merge references have no
independent historical retention requirement. Raw credentials remain transient;
persist hashes and never log secrets.

The public request and response shapes, link lifetimes, account-switch approval,
optional guest merge and session revocation policies remain compatible. A recorded
guest that has already merged or become verified is not merged again; an otherwise
valid sign-in proceeds. Do not follow its merge chain to choose another source.
Source sessions remain attached to the tombstoned Account so the existing merged
session response still works. Email cleanup cannot remove sessions.

The intentional behavior changes are that opening an expired link no longer loses
pending intent, stale intent is rejected during resend, and concurrent first
sign-ins share one pending Account.

## Migration and verification

Rewrite the disposable pre-beta Alembic baseline; do not backfill legacy tokens or
build an upgrade path solely to preserve pre-beta data. No shared environment is
reset by this implementation. After #1670 freezes the baseline, schema changes
must use forward, data-preserving migrations.

Use incremental red-to-green tests through the existing HTTP interfaces for email
round trips, intent lifetime, stale intent, replacement, one-time consumption,
sessions and merges. Stage database contention to verify concurrent operations
block before releasing them. Fresh Alembic installs, ORM/schema parity and direct
SQL rejection tests verify purposes, required/forbidden fields, foreign keys and
uniqueness. Seed every supported credential flavor without exposing secrets.

## Amended decisions

This supersedes the shared `user_tokens` representation in
[Accounts authorize durable Players](20260905-accounts-authorize-durable-players.md),
while preserving its Account ownership and merge policies. It also supersedes the
statement that no new session table is introduced in
[Session eviction requires explicit identity recovery](20260904-session-eviction-requires-explicit-identity-recovery.md).
That decision's recovery, approval and session revocation behavior remains in force.
