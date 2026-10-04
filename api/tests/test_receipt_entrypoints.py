"""The real entry points of the receipt work (#1810).

The other tests call the inner functions. These run the two paths a worker and a
CronJob actually take: the RQ job's synchronous entry point (its own engine from
``DATABASE_URL``), and ``python -m app.receipt_address_sweep`` in a subprocess.
"""

import asyncio
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app import email
from app.models import Tournament, TournamentCheckout, TournamentStatus
from app.tournament_payments import send_payment_receipt_email
from tests.test_payment_receipts import _paid_checkout, _SentEmails

ADDRESS = "receipts@example.com"
API_DIR = Path(__file__).resolve().parent.parent


async def test_the_rq_job_entry_point_sends_the_receipt_email(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    postgres_url: str,
) -> None:
    _payer, _owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, receipt_address=ADDRESS
    )
    monkeypatch.setenv("DATABASE_URL", postgres_url)
    sent = _SentEmails()
    monkeypatch.setattr(email, "_deliver", sent)

    # Exactly what the RQ worker calls: a sync function with a string argument.
    send_payment_receipt_email(str(payment.id))

    [message] = sent.sent
    assert message["to_email"] == ADDRESS
    assert payment.reference in message["body"]
    assert f"/payments/{payment.id}/receipt" in message["body"]


async def test_the_sweep_cli_erases_a_due_address_and_logs_no_address(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    postgres_url: str,
) -> None:
    _payer, _owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, receipt_address=ADDRESS
    )
    tournament = await db_session.get(Tournament, payment.tournament_id)
    assert tournament is not None
    tournament.status = TournamentStatus.archived
    await db_session.commit()
    # Archival is stamped by the database and immutable, so backdate it the way
    # the test reset does: with triggers off, inside one transaction.
    forty_days_ago = datetime.now(UTC) - timedelta(days=40)
    await db_session.execute(text("SET LOCAL session_replication_role = replica"))
    await db_session.execute(
        text(
            "UPDATE tournaments SET archive_observed_at = :t, archived_at = :t "
            "WHERE id = :id"
        ),
        {"t": forty_days_ago, "id": tournament.id},
    )
    await db_session.commit()

    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "app.receipt_address_sweep",
        cwd=API_DIR,
        env={"PATH": "/usr/bin:/bin", "DATABASE_URL": postgres_url},
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    output, _ = await process.communicate()

    assert process.returncode == 0, output.decode()
    assert ADDRESS not in output.decode()
    await db_session.refresh(payment)
    checkout = await db_session.get(TournamentCheckout, payment.checkout_id)
    assert checkout is not None
    await db_session.refresh(checkout)
    assert (checkout.receipt_address, payment.receipt_address) == (None, None)
    assert payment.receipt_address_erased_at is not None
