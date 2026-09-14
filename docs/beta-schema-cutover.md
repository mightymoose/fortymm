# Beta schema freeze and cutover (#1670)

Status: freeze PR preparation. Migration history freezes when this PR merges to
`main`; preparing or opening the PR does not freeze it. UAT and production have
not been cut over by this work. #1670 stays open until both complete their
separate operational cutovers and compatibility checks.

## Approved scope

The owner explicitly deferred reusable teams (#1673) and team encounters (#1674)
on 2026-09-13. They no longer block this freeze, superseding that dependency in
#1670/#1669. Their eventual implementation must use forward, data-preserving
migrations. This freeze does not claim team scenarios are implemented or tested.
All other redesign work and the integrated current-model verification remain
part of the gate. No new UI, payments or organizations are included.

## Frozen source

| Property | Value |
| --- | --- |
| Alembic revision | `0001` |
| Source commit containing the baseline | `0e8fce1d1c6c8d4ff24d17666957164c93ba4113` |
| Migration file | `api/migrations/versions/20260905_0000_0001_pre_beta_baseline.py` |
| SHA-256 | `1cecd3d9c5b3145b6c7db3a803655c026ab6bb9613208f579e6daccdc8f0469e` |
| Machine-readable record | `api/migrations/beta-baseline.json` |
| Effective freeze point | Merge commit of this freeze PR (record its link in #1670) |

Keep the existing filename and revision; the word `pre_beta` is historical, not
permission to rewrite it. No further consolidation is needed. If the baseline
changes on `main` before this PR merges, refresh and reverify this candidate
rather than freezing a stale checksum.

Every migration becomes immutable on merge to `main`, even before deployment.
New forward migrations are allowed; edits, renames, deletions and consolidation
of merged migrations are not. CI compares against trusted base history and the
frozen manifest, rather than trusting hashes changed in the same PR. The guard
runs inside the existing required `pytest` check before API path filtering.
Changes to CI enforcement require review; repository administrators can still
change branch protection, so this is not an administrator-proof security boundary.

## Verification and release records

Fresh installation, catalogue seeds, schema parity and direct SQL integrity
checks continue throughout implementation. The existing backend suite runs on
real Alembic installations. This fulfills the migration portion of #1213 without
closing or absorbing its unrelated map UI or migration-lint work.

Run from `api/` using the project's Python environment:

```bash
ruff check app tests
ruff format --check app tests
mypy
pytest tests/test_identity_migrations.py tests/test_beta_migration_upgrades.py
pytest
```

Run the migration-history guard and its isolated Git regression suite through the
commands in `.github/workflows/api.yml`. Record the tested commit and command
results in the PR. The current-model suite must cover account/player identity,
guest/merge, singles/doubles, corrections, rating/advancement provenance,
withdrawal, table availability and retention. Current API/UI compatibility must
be verified against the actual artifacts; backend tests alone do not certify a
live deployment or an installed TestFlight build.

`tests/test_beta_migration_upgrades.py` exercises populated forward upgrades from the
frozen baseline and the revision in `migrations/released-schema.json`. Preserve
the frozen fixture and add targeted regressions for future migration behavior.
At this first freeze both origins are `0001`, so upgrading to head is initially
a no-op. This establishes retained-data assertions, not evidence that an unseen
future migration works. Future migrations make these paths nontrivial.

The release record initially says `initial-beta-candidate` with no release
commit: nothing has been deployed by this PR. After the first successful beta
release, record its revision and exact source commit with status `released`.
Thereafter update that record after each successful release, before merging
further schema changes, so the next migration is tested from the actual latest
released schema. UAT and production retain their individual deployed artifact
records below; the latest release is not necessarily deployed in both. If they
diverge, also verify the older deployed revision before upgrading that environment.
Never move the recorded revision forward just to skip a failing upgrade test.
CI verifies that the recorded release commit exists in the current history,
that its sole migration head matches the record, and that its historical
migration files remain unchanged. It reads literal Alembic revision metadata
without executing historical migration or application code.
The record cannot return to candidate status or move to an older commit/schema
than the trusted base branch's record. It tracks the furthest released schema;
an application rollback leaves it unchanged. CI supplies `MIGRATION_BASE_SHA`;
local runs compare against the merge-base with `origin/main` and require full
Git history.

For every later schema-changing PR:

1. Add a forward migration and regression coverage for its populated data changes.
2. Pass fresh installation/parity and both populated upgrade origins.
3. Demonstrate compatibility of the upgraded database with the deployed and
   incoming API and worker versions. Record source/image versions and commands;
   automated schema parity alone cannot prove this application contract.
4. Use staged expand/contract releases for incompatible changes. Verify app
   rollback against the upgraded schema; database downgrade is not the rollback.

The existing Helm migration hook runs after install/upgrade. This freeze makes
no rollout changes: future schema-changing deployments must explicitly sequence
migration and application readiness to satisfy the compatibility contract. Do
not assume the hook alone supplies that evidence.

## Separate environment cutovers

This PR does not reset, deploy or open either environment. UAT and production may
open independently. Each preserves all data from its own beta opening onward;
#1670 closes only after both complete cutover and compatibility checks. Initial
iOS access requires a designated beta-ready TestFlight build. Subsequent releases
preserve compatibility for supported beta builds.

Before execution, the operator must complete this record for each environment.
Configuration names are discovery hints, not authorization or proof of a live
reset target. Production setup is still operator work; do not infer its target
from a local uncommitted values file.

| Required record | UAT | Production |
| --- | --- | --- |
| Host and Kubernetes context/cluster | Verify live host and configured `fortymm-uat` | Operator to identify |
| Namespace and Helm release | Verify `fortymm-uat` / `fortymm-uat` | Operator to identify |
| PostgreSQL server/database | Verify service `postgres`, configured DB `fortymm` | Operator to identify |
| Exact PVC and bound PV identity | Verify namespace-scoped `postgres-data` and bound PV | Operator to identify |
| Evidence data is still disposable pre-beta | Pending | Pending |
| Target-specific reset procedure | Pending live inventory | Pending live inventory |
| Frozen revision/checksum and source | Record at cutover | Record at cutover |
| Chart/API/web/worker digests | Record at cutover | Record at cutover |
| Beta-ready iOS build and supported API | Record before opening | Record before opening |
| Compatibility checks and results | Pending | Pending |
| Opening timestamp and operator | Not opened by this work | Not opened by this work |

For each environment:

1. Confirm the freeze PR has merged and verification is complete. Record the
   exact target and confirm it has not admitted beta users.
2. Stop traffic and all writers, including API, workers and scheduled processes.
   Review the exact target-specific reset/reinitialization commands against the
   recorded database/storage identities. Do not use blanket volume/cluster cleanup.
3. Execute the separately authorized pre-beta reinitialization, install the
   frozen schema from empty and deploy compatible pinned artifacts. Keep synthetic
   verification scenarios isolated from user data.
4. Verify revision, catalogue seeds, API/web flows and the beta-ready iOS build
   against the deployed artifacts. Record the evidence, not only command exits.
5. Record the successful checks and beta opening timestamp, then admit users.
   From this point onward all collected beta data must be preserved.

Before opening, a failed cutover may repeat the documented reset while the
specific target still holds only disposable pre-beta data. The frozen migration
files remain unchanged. After opening, use preserving forward fixes or compatible
application rollback; routine reset and destructive downgrade-to-base are not
recovery paths. Synthetic local, CI and QA databases remain resettable regardless
of the freeze, and QA cleanup still applies to those disposable stacks.

A backup-and-restore rehearsal is not a beta-opening requirement under the
owner's agreed #1670 contract. This does not claim recovery has been verified.
Unrelated databases, beta data and user source edits remain outside reset scope.
