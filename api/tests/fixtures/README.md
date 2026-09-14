`beta-0001.json` is a frozen, synthetic PostgreSQL data fixture for revision
`0001`. It contains no user/environment data. Keep it independent of current
ORM models and seed helpers: an upgrade test must load the old schema's data.
Do not regenerate it to accommodate a new migration; add targeted fixtures and
semantic assertions for new behavior instead.

It was captured from committed baseline rows using `SELECT to_jsonb(t)` after
running these existing domain scenarios together:

- `test_official_results.test_correction_and_restoration_append_to_latest_and_preserve_consent`.
- `test_advancement_decisions.test_replacement_appends_and_rejects_an_outdated_expected_decision`.
- `test_rating_inputs.test_replacement_preserves_original_slot_and_original_fact`.
- `test_cancelled_placement_retention.test_cancelled_event_retains_placement`
  with `change="table_id=NULL"`.
- `test_withdrawal_actor_activity.test_withdrawal_history_survives_actor_lifecycle_and_fresh_restoration`
  with `erased=False`.
- `_standing_doubles_match` from the notification visibility tests (unrated;
  doubles rating support is not implied).
- An explicit Account/Player grant with different IDs and a login identity,
  plus an active outage on the retained venue table.

During preparation of the freeze PR, this fixture was extended by loading the original
synthetic rows into a fresh `0001` database and committing the following writes
with normal baseline constraints and retention triggers enabled:

- `grant_director`, `revoke_director`, and `transfer_ownership` retain an active
  delegation, a revoked delegation, and a separate ownership transition.
- `LeagueMembership` retains the delegated account's sporting player's membership.
- `Notification` records contain read and unread result notices;
  `NotificationChannelSetting` disables email, and `NotificationPreference`
  stores both disabled push and enabled email category overrides.
- `required_repairs.request_rating`, `claim`, `complete`, and `fail` create four
  separate repair targets with running, completed, transient-failure and
  permanent-failure attempt outcomes and matching parent leases/states.
- Synthetic permission/role assignments retain authorization membership;
  registration and table-call rows retain their intervals and table identity.
- `void_official_match` adds a retained administrator void. Updating an independent
  tournament to `archived` lets the baseline trigger capture archive history.
- Account session/email credentials, a device registration, a pending change-email
  intent, and a pending first-sign-in intent cover remaining account-owned state.
  The credential digests are fixed synthetic `11`/`22` bytes; the device token is
  the literal `SYNTHETIC-NON-APNS-DEVICE-TOKEN`. Emails use `example.invalid`.
  Credential creation timestamps are fixed at 2040 so preservation tests do not
  accidentally exercise expiry cleanup. No real credential/device data or network
  delivery is involved, and these tests do not claim to validate authentication.

The extension was exported using `SELECT to_jsonb(t)` only after successful commits
and explicit FK checks. Its temporary generator was removed. This is preparation
of the initial freeze fixture; subsequent migrations must add targeted fixtures
instead of rewriting this historical input.

The fixture also includes catalogue/supporting rows needed for those facts.
Restoration temporarily disables triggers only inside a transaction on a newly
created disposable database, then restores enforcement before any upgrade.
The pre-merge fixture extension audits all 67 tables in the actual `0001`
PostgreSQL schema, not only the initially populated tables. The loader rejects
any baseline table without fixture rows, and the preservation test rejects any
unclassified table. All 59 non-catalogue, non-projection tables
retain their original columns (except `updated_at`), and additive columns are
allowed. This includes tournament/event/league roots and settings, draw revisions,
stages and groups, reservations and table memberships, recorded-game observations,
lifecycle/reconciliation evidence, identities, sporting results and child scores,
pending repair requirements and attempt outcomes, notification feed/read state
and explicit preferences, scoped/global authority and league memberships, account
credentials/intents/device ownership, and the historical schedule-solve ledger. Pending
work and operational history are not assumed to be disposable projections.

Six catalogues retain the original rows' semantic identity while allowing new
rows and presentation/policy changes:

| Catalogue | Preserved columns on original rows | Allowed changes |
| --- | --- | --- |
| `draw_types` | `id`, `key` | Name, description, order, timestamps, new types |
| `notification_channels` | `id`, `key` | Labels, description, order, active/available flags, timestamps, new channels |
| `notification_types` | `id`, `key` | Labels, description, order, active flag, timestamps, new types |
| `permissions` | `id`, `name` (authorization key) | Description, timestamps, new permissions |
| `roles` | `id`, `name` (authorization key) | Description, timestamps, new roles |
| `rating_strategies` | `id`, `key`, `version`, `state_schema`, `initial_state`, `initial_rating_value`, `is_automatic` | Name, description, timestamps, new strategy versions |

No baseline table is left unseeded or excluded from preservation checks.
`rating_history` and `user_league_ratings` are compared by semantic contents,
including row multiplicity, player/league/strategy identity, rating values and
state, source, actor, original input/result links, notes, previous rating, and
historical timeline. Replay may regenerate only their surrogate `id` values;
current `user_league_ratings` creation/update bookkeeping timestamps may also
change. `rating_history.created_at` is the history timeline and must remain.
Deleting or corrupting either projection without an equivalent replay fails,
even if all source inputs and official results survive.

Volatile values (leases, attempt progress, credential dates, read state) are
preserved as data during a schema upgrade; background workers and expiry cleanup
do not run in this fixture test. A migration intentionally reconciling that state
needs explicit semantic checks showing retained ownership, obligations, and
history. This does not waive behavioral replay tests for a migration that
changes rating calculations or storage.

Explicit FK anti-joins validate restored and upgraded relationships, since
reenabling triggers alone does not check previously loaded rows. Tests also
exercise identity/result write protection, demonstrate that child-score and
root-record mutations are detected with valid FKs, and verify that new catalogue
rows and display-label edits do not falsely report historical-data loss.

Both tracked origins initially equal `0001`, so the first freeze run is a
populated no-op upgrade. Subsequent forward migrations exercise real upgrades.
The released-origin path starts with this fixture at `0001`, advances it to the
tracked release, then upgrades to head; release-specific features need additional
migration regression fixtures in the PR that introduces them.
