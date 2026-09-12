# Inspecting and retrying required repairs

Required repairs cover tournament scheduling and rating recompute after Player
merges. The API records them in PostgreSQL with the mutation that requires them.
Redis/RQ carries wakeups. An empty Redis queue does not prove all repairs finished.

Use the API environment and its normal `DATABASE_URL`. From `api/`, with the
project virtual environment active:

```sh
python -m app.repair_cli list
python -m app.repair_cli retry <repair-id>
```

`list` shows permanently failed repairs and their diagnostic information. Inspect
the reported error and structured worker logs, correct the cause, then retry the
specific repair ID. A retry retains attempt history and makes the repair eligible
for execution. It does not report that the repair has already succeeded. A new
mutation affecting the target also makes a failed repair eligible again.

The API dispatches immediately after commit and scans durable pending work every
30 seconds. The scanner runs in the API lifecycle and resumes after process
restart; multiple replicas may scan safely. RQ workers for the existing solver
and ratings queues must be running for execution. No separate scheduler
deployment or Redis repair registry is required.

Transient failures initially wait 30 seconds and double the delay up to one hour.
Recovery respects active worker claims and their leases, so a 30-second scan
interval is not a promise that all work completes within 30 seconds. Claims allow
at least 15 minutes, extended for a raised solver time cap; rating replay renews
its lease between league transactions. A killed worker's work becomes eligible
after its claim expires. A permanent failure is retained for explicit retry. An
infeasible schedule is a completed domain outcome: changing its inputs or
requesting another solve is the normal next step.

Completed operational records are eligible for cleanup after 30 days. Unresolved
failures stay available until resolved. Cleanup does not delete match results,
rating inputs or other domain history. Deleting a tournament through an otherwise
permitted domain operation cancels its now-unnecessary repair; repair records do
not grant permission to delete history-bearing tournaments.

The [repair decision](adr/20260912-required-repairs-commit-with-their-mutations.md)
records the transaction, coalescing and failure policies. External alert delivery
and serialization of all rating writers are separate concerns.
