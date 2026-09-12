# Required repairs commit with their mutations

Status: Accepted for #1689 and #1714, following the design interview. Part of #1669.

PostgreSQL owns pending required work. A mutation and its repair intent commit
in the same transaction. Redis/RQ wakes workers; enqueue success cannot discharge
the repair obligation. This covers schedule reconciliation and rating recompute
after a same-person Player merge. Synchronous rating corrections remain atomic
with their replay, as specified by the rating-inputs ADR.

## Acceptance and execution

A schedule request that commits its repair intent succeeds with the existing
queued status even when Redis is unavailable. A successful response means the
request was accepted durably, not that execution has started. Rollback removes
the corresponding intent, including changes rolled back to a savepoint.

Pending changes for a target may coalesce into a repair of its latest committed
state. Every mutation advances its requested generation. A worker captures a
generation and can acknowledge only that generation; a later mutation remains
pending. Repeated delivery must be idempotent. A worker that has lost ownership
must not acknowledge another worker's claim or overwrite its result.

Immediate dispatch follows commit. A database scan every 30 seconds provides
recovery without a new user request, including a crash before dispatch, a Redis
outage, loss of queued jobs, or worker/pod loss. The existing API lifecycle runs
the scanner, with safe concurrent scans across replicas and cancellation on
shutdown. No new deployment artifact is required. A scan interval is a recovery
cadence, not an execution deadline: queue load, active leases and retry backoff
may delay execution.

Transient failures retry with capped backoff. Permanent failures remain durable
and require an explicit retry, unless a new mutation supplies a new generation,
which makes the target eligible again. Previous attempt details remain available.
An infeasible schedule is a domain outcome, not a transport or worker failure.
Transient schedule failures retain their failed ledger entry and expose a queued
retry through the existing status model, so pre-live clients keep polling during
backoff. Creating that retry does not advance the repair generation or reset its
backoff. A reader does not reap a solve owned by a durable repair claim.

Operators can list failed repairs and retry a selected repair by stable ID through
a CLI. Structured error logs and CLI inspection provide diagnostics; external
alerting is separate work. Completed operational records have 30-day retention.
Unresolved failures are retained until repaired or explicitly resolved. Operational
cleanup must never remove domain history, including official result revisions,
rating inputs and retained provenance.

## Library decision

Use a focused PostgreSQL module with SQLAlchemy and the existing RQ workers.
Callers supply their active session; claim, dispatch, retry and acknowledgment
rules live inside the module. Alembic owns its tables alongside the application
schema. This avoids a second authoritative ledger for the same repair.

The alternatives evaluated on 2026-09-12 were:

- [Procrastinate](https://procrastinate.readthedocs.io/en/stable/howto/production/external_connection.html)
  supports insertion on a caller-owned transaction. Its documented supported
  external connections use psycopg or synchronous SQLAlchemy with psycopg2;
  the application's SQLAlchemy AsyncSession/asyncpg connection is not among
  those supported connectors. Adopting it would require additional driver and
  worker integration beyond an RQ outbox adapter. Using a separate connection
  would defeat atomicity.
- [outbox-streaming](https://github.com/hyzyla/outbox-streaming) explicitly marks
  its RQ/SQLAlchemy integrations as unfinished with missing tests and advises
  against production use. It does not justify taking a dependency for this path.

This is a compatibility decision for the present stack, not a claim that mature
transactional job libraries cannot replace it later. A replacement must preserve
the same transactional and recovery behavior.

## Amended decisions and scope

- [The schedule is solved; the call is pinned](20260716-the-schedule-is-solved-the-call-is-pinned.md):
  preserve the solve ledger, coalescing and guarded whole-result apply. Durable
  repair intent now owns dispatch and generation completion.
- [A stale running solve is reaped by the next reader or request](20260718-a-stale-running-solve-is-reaped-by-the-next-reader-or-request.md):
  supersede reader/request-only recovery and permission to silently drop a rerun
  on failure. Recovery scanning retains the obligation without another request.
- [Rating inputs outlive rebuildable projections](20260911-rating-inputs-outlive-rebuildable-projections.md):
  preserve per-league background merge replay and synchronous correction
  transactions; merge replay is now requested durably in the merge transaction.

Required repair targets reference the sporting Player or tournament, rather than
an authentication Account. They do not replace result/rating provenance. The
rating-writer serialization defect remains a separate concern: reliable delivery
does not itself make concurrent rating calculations correct.

Realtime refetch hints remain best-effort. Notifications, email delivery, schedule
previews, new UI and deployments are outside this change. The pre-beta migration
policy permits editing the baseline until #1670; existing data does not require a
backfill, and no shared environment is reset by this implementation.

## Verification

Develop in behavioral red/green cycles through the producer, worker, recovery and
operator interfaces. Exercise Redis failure, rollback, commit-before-dispatch
crashes, duplicate delivery, worker retry and stale ownership. Stage concurrency
to prove older completion cannot erase a newer generation. Use actual fresh
Alembic installs, schema parity and direct SQL tests for the declared database
constraints, plus backend regression tests for both repair paths.
