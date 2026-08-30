"""Runnable entry point for the periodic email-confirmation token sweep (#1616).

``python -m app.email_token_sweep`` runs exactly one sweep and exits:
:func:`sweep_expired_email_tokens` deletes every *replaced* pending-email
token row (change or merge flavour) older than its ``EMAIL_CONFIRM_TOKEN_LIFETIME``
— across all users, in one statement.

Why a scheduled sweep at all: a replaced row survives its supersession only so
a click on the dead link can still report "a newer link was requested"
(#1616), and until now its lifetime was bounded only by later *activity* — the
age-keyed delete in ``app.sessions._issue_confirmation_token`` (the user's
next issuance) and ``_sweep_replaced_email_tokens`` (the confirm paths). A
user who requests a chain of links and then never opens the newest one nor
requests another runs neither, leaving every replaced row — and the
``sent_to`` address it holds — in the table indefinitely (#1632). This sweep
is the independent bound: it removes those rows whether or not anything ever
touches the account again.

Deleting an expired replaced row is behavior-preserving: ``confirm_email``
checks expiry *before* replacement, so a click on such a row already reports
the plain "invalid or expired" — exactly what it reports once the row is
gone. Unreplaced rows are deliberately left alone: an expired live token
stays the resend target (``_pending_change_token`` does not filter by age),
and deleting it would turn a working "resend" into a hard 400.

The pending-email predicate and lifetime are reproduced here rather than
imported from ``app.sessions``, per api/CLAUDE.md ("don't import another
router's internals" — the sessions router also builds Settings-bound rate
limiters at import time, which a cron entry point must not pull in).
``tests/test_email.py`` pins the reproduction against the router's originals
so the two cannot drift.

The recurring cadence lives in the *deployment*, not here, mirroring the
retirement sweep (``app.retirement_sweep``):

* UAT (k8s): a Helm ``CronJob``
  (``deploy/fortymm/templates/email-token-sweep-cronjob.yaml``), hourly,
  ``concurrencyPolicy: Forbid`` — one run per tick regardless of how many api
  replicas are up, so no duplicate-execution race.
* docker-compose (dev/qa): the ``retirement-sweep`` looping service runs this
  module right after the retirement sweep on the same tick.

Any cadence comfortably under 24h bounds a replaced row's total life to
little more than its own lifetime; hourly matches the retirement sweep.
"""

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from typing import Any, cast

from sqlalchemy import ColumnElement, delete, or_
from sqlalchemy.engine import CursorResult
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db import get_engine
from app.models import UserToken

logger = logging.getLogger(__name__)

# Reproduced from ``app.sessions`` (see the module docstring for why). The
# lifetime must match the router's exactly: a smaller value would delete
# replaced rows that can still report "replaced" on click, and a larger one
# merely delays cleanup. ``tests/test_email.py`` asserts the equality.
EMAIL_CONFIRM_TOKEN_LIFETIME = timedelta(hours=24)
EMAIL_CHANGE_CONTEXT_PREFIX = "change:"
EMAIL_MERGE_CONTEXT_PREFIX = "merge:"


def _pending_email_token_clause() -> ColumnElement[bool]:
    """Reproduced from ``app.sessions._pending_email_token_clause`` (see the
    module docstring for why)."""
    return or_(
        UserToken.context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX),
        UserToken.context.startswith(EMAIL_MERGE_CONTEXT_PREFIX),
    )


async def sweep_expired_email_tokens(db: AsyncSession) -> int:
    """Delete every replaced pending-email token past its lifetime, across
    all users. Returns the number of rows removed. Runs in the caller's
    transaction — does not commit, mirroring the confirm-path sweeps."""
    result = await db.execute(
        delete(UserToken).where(
            _pending_email_token_clause(),
            UserToken.replaced_at.is_not(None),
            UserToken.created_at < datetime.now(UTC) - EMAIL_CONFIRM_TOKEN_LIFETIME,
        )
    )
    return cast(CursorResult[Any], result).rowcount or 0


def run_email_token_sweep() -> None:
    """Sync entry point. Opens its own session and commits, mirroring
    ``app.retirement_jobs.run_retirement_sweep``."""
    asyncio.run(_run_email_token_sweep())


async def _run_email_token_sweep() -> None:
    sessionmaker = async_sessionmaker(get_engine(), expire_on_commit=False)
    async with sessionmaker() as db:
        deleted = await sweep_expired_email_tokens(db)
        await db.commit()
    logger.info(
        "Email-token sweep: deleted %d replaced confirmation token(s) past "
        "their lifetime",
        deleted,
    )


def main() -> None:
    run_email_token_sweep()


if __name__ == "__main__":
    main()
