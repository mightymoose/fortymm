"""Cookie-authenticated reads serialize with account suspension."""

import asyncio
from datetime import UTC, datetime

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker

from app import sessions
from tests._helpers import start_session


@pytest.mark.parametrize("endpoint", ["/v1/session", "/v1/notifications"])
async def test_authenticated_session_read_holds_activity_until_response(
    api_client, db_session, engine, monkeypatch, endpoint
):
    user = await start_session(api_client, db_session)
    user.last_seen_at = datetime.now(UTC)
    account_id = user.id
    await db_session.commit()
    entered = asyncio.Event()
    release = asyncio.Event()
    from app.notifications.service import NotificationService

    target = sessions if endpoint == "/v1/session" else NotificationService
    attribute = "_build_session_response" if endpoint == "/v1/session" else "list_feed"
    original = getattr(target, attribute)

    async def paused(db, actor, *args, **kwargs):
        entered.set()
        await release.wait()
        return await original(db, actor, *args, **kwargs)

    monkeypatch.setattr(target, attribute, paused)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as suspender, factory() as observer:
        read_pid = await db_session.scalar(text("SELECT pg_backend_pid()"))
        suspend_pid = await suspender.scalar(text("SELECT pg_backend_pid()"))
        request = asyncio.create_task(api_client.get(endpoint))
        await asyncio.wait_for(entered.wait(), 5)
        suspension = asyncio.create_task(
            suspender.execute(
                text("UPDATE accounts SET deactivated_at=now() WHERE id=:id"),
                {"id": account_id},
            )
        )
        try:
            async with asyncio.timeout(5):
                while read_pid not in await observer.scalar(
                    text("SELECT pg_blocking_pids(:pid)"), {"pid": suspend_pid}
                ):
                    if suspension.done():
                        await suspension
                        pytest.fail("suspension passed an authenticated read")
                    await asyncio.sleep(0.01)
            release.set()
            assert (await request).status_code == 200
            await db_session.rollback()
            await suspension
            await suspender.commit()
        finally:
            release.set()
            await request
            await db_session.rollback()
            await suspension


async def test_suspension_winning_before_stamping_cannot_record_activity(
    api_client, db_session, engine, monkeypatch
):
    user = await start_session(api_client, db_session)
    account_id = user.id
    user.last_seen_at = None
    await db_session.commit()
    before = user.last_seen_at
    entered = asyncio.Event()
    release = asyncio.Event()
    original = sessions._stamp_last_seen

    async def paused(db, actor, raw_token):
        entered.set()
        await release.wait()
        await original(db, actor, raw_token)

    monkeypatch.setattr(sessions, "_stamp_last_seen", paused)
    request = asyncio.create_task(api_client.get("/v1/session"))
    await asyncio.wait_for(entered.wait(), 5)
    try:
        async with async_sessionmaker(engine)() as suspender:
            await suspender.execute(
                text("UPDATE accounts SET deactivated_at=now() WHERE id=:id"),
                {"id": account_id},
            )
            await suspender.commit()
    finally:
        release.set()
    assert (await request).status_code == 401
    assert (
        await db_session.scalar(
            text("SELECT last_seen_at FROM accounts WHERE id=:id"), {"id": account_id}
        )
        == before
    )


async def test_suspension_after_stamp_commit_is_rechecked_before_private_feed(
    api_client, db_session, engine, monkeypatch
):
    user = await start_session(api_client, db_session)
    user.last_seen_at = None
    account_id = user.id
    await db_session.commit()
    original = sessions._stamp_last_seen

    async def suspend_after_stamp(db, actor, raw_token):
        await original(db, actor, raw_token)
        async with async_sessionmaker(engine)() as suspender:
            await suspender.execute(
                text("UPDATE accounts SET deactivated_at=now() WHERE id=:id"),
                {"id": account_id},
            )
            await suspender.commit()

    monkeypatch.setattr(sessions, "_stamp_last_seen", suspend_after_stamp)
    assert (await api_client.get("/v1/notifications")).status_code == 401


async def test_concurrent_stale_cookie_stamps_do_not_upgrade_shared_locks(
    api_client, db_session, engine, monkeypatch
):
    user = await start_session(api_client, db_session)
    user.last_seen_at = None
    await db_session.commit()
    raw = api_client.cookies.get(sessions.SESSION_COOKIE_NAME)
    barrier = asyncio.Barrier(2)
    original = sessions._stamp_last_seen

    async def together(db, actor, raw_token):
        await barrier.wait()
        await original(db, actor, raw_token)

    monkeypatch.setattr(sessions, "_stamp_last_seen", together)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async def resolve():
        async with factory() as db:
            actor = await sessions._resolve_current_user(
                db, session_cookie=raw, lock_read=True
            )
            assert actor is not None
            stamp = actor.last_seen_at
            await db.rollback()
            return stamp

    async with asyncio.timeout(5):
        first, second = await asyncio.gather(resolve(), resolve())
    assert first is not None and first == second


async def test_optional_cookie_read_rechecks_suspension_after_waiting(
    api_client, db_session, engine
):
    user = await start_session(api_client, db_session)
    account_id = user.id
    raw = api_client.cookies.get(sessions.SESSION_COOKIE_NAME)
    await db_session.commit()
    factory = async_sessionmaker(engine)
    async with factory() as suspender, factory() as reader:
        suspend_pid = await suspender.scalar(text("SELECT pg_backend_pid()"))
        read_pid = await reader.scalar(text("SELECT pg_backend_pid()"))
        await suspender.execute(
            text("UPDATE accounts SET deactivated_at=now() WHERE id=:id"),
            {"id": account_id},
        )
        read = asyncio.create_task(
            sessions.get_optional_user(session_cookie=raw, db=reader)
        )
        try:
            async with asyncio.timeout(5):
                while suspend_pid not in await db_session.scalar(
                    text("SELECT pg_blocking_pids(:pid)"), {"pid": read_pid}
                ):
                    if read.done():
                        await read
                        pytest.fail("optional authentication did not wait")
                    await asyncio.sleep(0.01)
            await suspender.commit()
            assert await read is None
        finally:
            await suspender.rollback()
            await read


@pytest.mark.parametrize("path", ["/v1/me/email", "/v1/me/email/resend"])
@pytest.mark.parametrize("erase", [False, True])
async def test_honeypot_session_response_rechecks_activity_after_authentication(
    api_client, db_session, engine, monkeypatch, path, erase
):
    from app.identity_lifecycle import deactivate_account, erase_account

    user = await start_session(api_client, db_session)
    user.email = "private-session@example.com"
    await db_session.commit()
    original = sessions._resolve_current_user

    async def suspend_after_resolution(db, **kwargs):
        actor = await original(db, **kwargs)
        assert actor is not None
        async with async_sessionmaker(engine)() as lifecycle:
            await (erase_account if erase else deactivate_account)(lifecycle, actor.id)
            await lifecycle.commit()
        return actor

    monkeypatch.setattr(sessions, "_resolve_current_user", suspend_after_resolution)
    response = await api_client.post(
        path,
        json={
            "email": "new@example.com",
            "captcha_token": "test-token",
            "fmm_hp_token": "filled",
        },
    )
    assert response.status_code == 401, response.text
    assert "private-session@example.com" not in response.text


async def test_email_response_rechecks_activity_after_credential_commit(
    api_client, db_session, engine, monkeypatch
):
    from app.identity_lifecycle import deactivate_account

    user = await start_session(api_client, db_session)
    account_id = user.id
    original = sessions._build_session_response

    async def suspend_before_response(db, actor, *args, **kwargs):
        async with async_sessionmaker(engine)() as lifecycle:
            await deactivate_account(lifecycle, account_id)
            await lifecycle.commit()
        return await original(db, actor, *args, **kwargs)

    monkeypatch.setattr(sessions, "_build_session_response", suspend_before_response)
    response = await api_client.post(
        "/v1/me/email",
        json={"email": "pending@example.com", "captcha_token": "test-token"},
    )
    assert response.status_code == 401


async def test_honeypot_response_holds_activity_while_reading_private_fields(
    api_client, db_session, engine, monkeypatch
):
    user = await start_session(api_client, db_session)
    account_id = user.id
    entered, release = asyncio.Event(), asyncio.Event()
    original = sessions._load_permissions

    async def pause_fields(db, user_id):
        entered.set()
        await release.wait()
        return await original(db, user_id)

    monkeypatch.setattr(sessions, "_load_permissions", pause_fields)
    factory = async_sessionmaker(engine)
    async with factory() as lifecycle, factory() as observer:
        read_pid = await db_session.scalar(text("SELECT pg_backend_pid()"))
        lifecycle_pid = await lifecycle.scalar(text("SELECT pg_backend_pid()"))
        response = asyncio.create_task(
            api_client.post(
                "/v1/me/email/resend",
                json={"captcha_token": "test-token", "fmm_hp_token": "filled"},
            )
        )
        await asyncio.wait_for(entered.wait(), 5)
        suspension = asyncio.create_task(
            lifecycle.execute(
                text("UPDATE accounts SET deactivated_at=now() WHERE id=:id"),
                {"id": account_id},
            )
        )
        try:
            async with asyncio.timeout(5):
                while read_pid not in await observer.scalar(
                    text("SELECT pg_blocking_pids(:pid)"), {"pid": lifecycle_pid}
                ):
                    if suspension.done():
                        await suspension
                        pytest.fail("suspension passed private response construction")
                    await asyncio.sleep(0.01)
            release.set()
            assert (await response).status_code == 202
            await db_session.rollback()
            await suspension
            await lifecycle.commit()
        finally:
            release.set()
            await response
            await db_session.rollback()
            await suspension
