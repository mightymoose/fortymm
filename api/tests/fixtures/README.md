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

The fixture also includes catalogue/supporting rows needed for those facts.
Restoration temporarily disables triggers only inside a transaction on a newly
created disposable database, then restores enforcement before any upgrade.
The upgrade tests compare original historical columns, allow additional columns,
and omit rebuildable rating/notification projections. Explicit FK anti-joins
validate restored and upgraded relationships, since reenabling triggers alone
does not check previously loaded rows. They also exercise retained
identity and official-result write protection after upgrading.

Both tracked origins initially equal `0001`, so the first freeze run is a
populated no-op upgrade. Subsequent forward migrations exercise real upgrades.
The released-origin path starts with this fixture at `0001`, advances it to the
tracked release, then upgrades to head; release-specific features need additional
migration regression fixtures in the PR that introduces them.
