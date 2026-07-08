"""Runnable entry point for the periodic retirement sweep (task #9 / ADR 0007 O8).

``python -m app.retirement_sweep`` runs exactly one full sweep and exits:
:func:`app.retirement_jobs.run_retirement_sweep` auto-accepts every lapsed
standing result and sends any due deadline-nearing reminders, inline, in its own
async session (it does the work directly — it does not fan out per-match jobs
onto the ``retirement`` RQ queue). So the "trigger" is nothing more than calling
this on a schedule; no RQ worker or queue is involved in firing it.

The recurring cadence lives in the *deployment*, not here, so the mechanism is a
single-shot process invoked once per tick:

* UAT (k8s): a Helm ``CronJob``
  (``deploy/uat/templates/retirement-sweep-cronjob.yaml``), hourly,
  ``concurrencyPolicy: Forbid`` — one run per tick regardless of how many api
  replicas are up, so no duplicate-execution race.
* docker-compose (dev/qa/uat): a small ``retirement-sweep`` service that loops
  ``python -m app.retirement_sweep`` with a ``sleep ${RETIREMENT_SWEEP_INTERVAL}``
  (default 3600s) between runs.

**Cadence guarantee:** the reminder's "~24h before the deadline" promise in
``app.retirement_jobs`` (see ``REMINDER_LEAD``) assumes this sweep runs **at
least daily**. The hourly default leaves comfortable margin; do not stretch the
interval past ~24h or a match whose entire reminder lead falls between two ticks
would be auto-retired without a reminder ever having been due.
"""

from app.retirement_jobs import run_retirement_sweep


def main() -> None:
    run_retirement_sweep()


if __name__ == "__main__":
    main()
