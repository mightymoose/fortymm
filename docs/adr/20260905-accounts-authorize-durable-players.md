# Accounts authorize durable Players

Status: Accepted. Implements #1671; the pre-beta baseline freezes at #1670.

## Decision

An Account authenticates and acts. A Player is the durable sporting identity: a
username, participation, tournament entries, league memberships and rating history.
Either may exist without the other. An explicit AccountPlayer grant authorizes an
Account to manage a Player's sporting activity. It does not grant authority to manage
other Accounts, login credentials or access grants.

An Account may manage several Players and a Player may have several managers. The
composite grant key prevents duplicates; a partial unique index permits at most one
primary Player per Account. Removing that grant leaves no primary; another managed
Player is never selected implicitly. Authorization excludes both Account and Player
tombstones. The current HTTP and MCP workflows act as the primary Player, preserving
today's interface. Accounts without a primary Player read as spectators: personal
panels are empty, while match browsing and player profiles remain available.
Player switching and grant-management UI remain deferred. Self-entry without a
primary Player returns a deliberate authorization refusal. The existing event
`entry_state` continues to describe rating eligibility and capacity, not grant
authority; a new account-selection or account-only entry affordance is deferred.

LoginIdentity belongs to Account. Its issuer/provider/subject tuple is unique, with
at most one identity per Account and issuer/provider. Existing Auth0 behavior uses
this relation; confirmed email, session and email tokens, roles and agent revocation
remain Account concerns. A guest session provisions Account, Player and a primary
grant together. Ordinary provisioning currently gives them matching initial UUIDs
for compatibility; neither foreign keys nor authorization infer a grant from ID
equality, and tests exercise different IDs throughout.

## Sign-in and same-person merge

The existing guest merge means "these are the same person". If the destination has a
primary Player, combine the source primary Player's sporting records into that
Player using the existing collision, draw and rating reconciliation rules, and
retire the source Player. If the destination has no primary Player, transfer the
source Player's management grant and retain the Player unchanged. In both cases,
transfer current tournament ownership and tombstone the source Account. Original
creators, result submitters/acceptors, entry adders and rating actors keep their
original Account references. A transfer never rewrites those historical actors.

The source loses its grants and cannot act after tombstoning. The existing role,
token, device, notification and Auth0 merge policies continue. More complex merges
involving multiple source Players or other managers of a Player being combined are
refused pending an explicit reconciliation design. Account transfer is the only
Player-management move exposed by today's flows.

Match-call occupancy uses the stable Player ID; managing Accounts are resolved
separately for notification delivery. Every live manager receives the call; an
unclaimed entrant does not prevent the other entrant being called. A transfer
cannot free a busy Player.

Result submission records both the acting Account and the represented Player, so
acceptance and retirement find the correct side after an Account transfer or Player
merge. Notifications resolve Player recipients to live managing Accounts. Existing
automatic acceptance records the owing Player's current managing Account. Retirement
with no managing Account and player-selection UI are not enabled by this change.

## Classification of every former User foreign key

Legacy column names remain where needed for API compatibility; their FK target is
the authoritative identity domain. `User` is a backend alias for Account, and its
username property projects its primary Player's username, falling back to a durable
Account display name after transfer or for an account-only director.

| Columns | Target and merge treatment |
| --- | --- |
| `match_side_players.user_id` | Player; participation combines only in an explicit same-person Player merge. |
| `tournament_entries.user_id` | Player; retain existing duplicate-entry and draw collision rules. |
| `league_memberships.user_id` | Player; combine memberships. |
| `user_league_ratings.user_id`, `rating_history.user_id` | Player; retain existing reconciliation/recompute policy. |
| `matches.created_by_user_id` | Account; preserve original creator. |
| `match_results.submitted_by_user_id`, `accepted_by_user_id` | Account; preserve original actors. |
| `rating_history.created_by_user_id` | Account; preserve original actor. |
| `tournaments.created_by_user_id` | Account; preserve original creator. |
| `tournament_entries.added_by_user_id` | Account; preserve original director; NULL still means self-registration. |
| `user_tokens.user_id` | Account; retain source session tokens for session-ended detection; remove other source tokens. |
| `user_roles.user_id` | Account; transfer missing role grants, deduplicate. |
| `device_tokens.user_id` | Account; remove source registrations under existing merge policy. |
| `notifications.user_id`, `notification_preferences.user_id`, `notification_channel_settings.user_id` | Account; remove source feed/preferences under existing merge policy. |
| Former `users.merged_into_user_id` | Account self-reference; retained on `accounts` as the tombstone destination. |

New references are `account_players.account_id` → Account,
`account_players.player_id` → Player, `login_identities.account_id` → Account,
`tournaments.owner_account_id` → current owning Account,
`match_results.submitted_for_player_id` → represented Player, and
`players.merged_into_player_id` → Player merge destination. Sporting and historical
actor references use RESTRICT on deletion. Tombstone destination and timestamp must
be set together, and neither Account nor Player may merge into itself.

## Migration and verification

Replace the disposable pre-beta migration chain with one static, self-contained
Alembic baseline, including the existing catalogue seeds. No legacy-data backfill or
populated-database upgrade path is provided. Databases that applied the old chain
must be explicitly reset to adopt it; this change does not reset any deployed or
shared environment. After #1670 freezes the baseline, use forward, data-preserving
migrations instead.

Tests cover independent and unclaimed identities, management authority, primary
selection, SQL constraints, sign-in/merge, actor preservation, stable Player transfer,
notification recipients, eligibility and retirement. A dedicated test installs the
actual Alembic baseline into a fresh database and compares it with ORM metadata.

## Amended decisions

This decision supersedes only the identity/ownership clauses of ADR-0013 (self-play
collision), ADR-0016 (tournament entry soft deletion), and ADR-0784 (director entry):
Player participation may combine; historical Account authorship never repoints.
Their sporting collision and registration behavior otherwise remains in force.

The July 22 Auth0 resource-server and auto-provisioning ADRs now resolve Account via
LoginIdentity, with Player creation and authority separate. The July 28 agent
revocation ADR applies to Account. Their authentication and revocation policies
otherwise remain in force.
