"""Failure recovery must not remove an action issued after its rollback."""

from datetime import UTC, datetime

from httpx import AsyncClient
from sqlalchemy import insert
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.db import get_session
from app.main import app
from app.models import User
from tests._helpers import make_client, start_session


async def test_failed_confirmation_preserves_request_issued_after_rollback(
    api_client: AsyncClient,
    db_session: AsyncSession,
    engine: AsyncEngine,
    fake_email_queue,
):
    # Record outgoing mail at the queue boundary; never send or log credentials.
    fake_email_queue._is_async = True
    await start_session(api_client, db_session)
    body = {"email": "contended@example.com", "captcha_token": "x", "fmm_hp_token": ""}
    assert (await api_client.post("/v1/me/email", json=body)).status_code == 202
    old_token = fake_email_queue.get_jobs()[-1].args[1]
    db_session.add(
        User(
            username="address-winner",
            email=body["email"],
            confirmed_at=datetime.now(UTC),
        )
    )
    await db_session.commit()
    replacement_body = {**body, "email": "replacement@example.com"}
    replacement_issued = False

    async with make_client() as requester, make_client() as clicker:
        requester.cookies.set("session", api_client.cookies.get("session"))

        class RecoverySession(AsyncSession):
            async def rollback(self) -> None:
                nonlocal replacement_issued
                await super().rollback()
                if not replacement_issued:
                    # Stage a successful independent transaction in the gap
                    # after the real unique-email failure releases its locks.
                    replacement_issued = True
                    result = await requester.post("/v1/me/email", json=replacement_body)
                    assert result.status_code == 202

        factory = async_sessionmaker(
            engine, class_=RecoverySession, expire_on_commit=False
        )

        async def independent_session():
            async with factory() as transaction:
                yield transaction

        app.dependency_overrides[get_session] = independent_session
        failed = await clicker.post("/v1/me/email/confirm", json={"token": old_token})
        assert replacement_issued, "The real uniqueness failure must reach rollback"
        assert failed.status_code == 400
        pending = await requester.get("/v1/session")
        assert (
            pending.json()["data"]["user"]["pending_email"] == replacement_body["email"]
        )
        confirmed = await clicker.post(
            "/v1/me/email/confirm",
            json={"token": fake_email_queue.get_jobs()[-1].args[1]},
        )
        assert confirmed.status_code == 200
        assert confirmed.json()["data"]["user"]["email"] == replacement_body["email"]


async def test_failed_first_sign_in_preserves_link_issued_after_rollback(
    api_client: AsyncClient,
    engine: AsyncEngine,
    fake_email_queue,
):
    fake_email_queue._is_async = True
    body = {
        "email": "first-recovery@example.com",
        "captcha_token": "x",
        "fmm_hp_token": "",
    }
    assert (await api_client.post("/v1/login/request", json=body)).status_code == 202
    old_token = fake_email_queue.get_jobs()[-1].args[1]
    replacement_issued = False
    failure_injected = False

    async with make_client() as requester, make_client() as clicker:

        class RecoverySession(AsyncSession):
            async def commit(self) -> None:
                nonlocal failure_injected
                if not failure_injected:
                    failure_injected = True
                    # At the database seam, cause a real unique-email failure
                    # after validation and before the sign-in can commit.
                    await self.execute(
                        insert(User).values(
                            email=body["email"], confirmed_at=datetime.now(UTC)
                        )
                    )
                await super().commit()

            async def rollback(self) -> None:
                nonlocal replacement_issued
                await super().rollback()
                if not replacement_issued:
                    replacement_issued = True
                    result = await requester.post("/v1/login/request", json=body)
                    assert result.status_code == 202

        factory = async_sessionmaker(
            engine, class_=RecoverySession, expire_on_commit=False
        )

        async def independent_session():
            async with factory() as transaction:
                yield transaction

        app.dependency_overrides[get_session] = independent_session
        failed = await clicker.post("/v1/login/consume", json={"token": old_token})
        assert failure_injected and replacement_issued
        assert failed.status_code == 400
        confirmed = await clicker.post(
            "/v1/login/consume",
            json={"token": fake_email_queue.get_jobs()[-1].args[1]},
        )
        assert confirmed.status_code == 200
        assert confirmed.json()["data"]["user"]["email"] == body["email"]
