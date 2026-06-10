from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import DeviceToken
from app.notifications.apns import SendOutcome
from tests._helpers import FakeSender, make_client, start_session, use_sender

# ``api_client`` (an ASGI client sharing the per-test ``db_session``) comes from
# tests/conftest.py — no need to redefine it here. ``FakeSender`` / ``use_sender``
# live in tests/_helpers so the match-result notification tests share them.


async def register(
    client: AsyncClient,
    token: str,
    *,
    environment: str = "sandbox",
) -> None:
    response = await client.post(
        "/v1/device-tokens",
        json={"token": token, "platform": "ios", "environment": environment},
    )
    assert response.status_code == 200, response.text


# --- registration -----------------------------------------------------------


async def test_register_inserts_token(
    api_client: AsyncClient, db_session: AsyncSession
):
    user = await start_session(api_client, db_session)
    await register(api_client, "tok-aaa")

    rows = (await db_session.execute(select(DeviceToken))).scalars().all()
    assert len(rows) == 1
    assert rows[0].token == "tok-aaa"
    assert rows[0].user_id == user.id
    assert rows[0].environment == "sandbox"


async def test_register_same_token_updates_in_place(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    await register(api_client, "tok-aaa", environment="sandbox")
    await register(api_client, "tok-aaa", environment="production")

    rows = (await db_session.execute(select(DeviceToken))).scalars().all()
    assert len(rows) == 1
    assert rows[0].environment == "production"


async def test_register_repoints_token_to_new_user(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The same physical device signing into a different account re-points the
    existing row rather than duplicating it (token is globally unique)."""
    await start_session(api_client, db_session)
    await register(api_client, "tok-shared")

    other = make_client()
    try:
        user_b = await start_session(other, db_session)
        await register(other, "tok-shared")
    finally:
        await other.aclose()

    rows = (await db_session.execute(select(DeviceToken))).scalars().all()
    assert len(rows) == 1
    assert rows[0].user_id == user_b.id


async def test_register_requires_session(api_client: AsyncClient):
    response = await api_client.post(
        "/v1/device-tokens",
        json={"token": "tok", "platform": "ios", "environment": "sandbox"},
    )
    assert response.status_code == 401


# --- test send --------------------------------------------------------------


async def test_test_send_fans_out_to_all_user_tokens(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    await register(api_client, "tok-1")
    await register(api_client, "tok-2", environment="production")

    sender = FakeSender()
    use_sender(sender)
    response = await api_client.post("/v1/notifications/test")

    assert response.status_code == 200
    assert response.json() == {"sent": 2, "pruned": 0}
    by_token = {push.token: push.environment for push in sender.sent}
    assert by_token == {"tok-1": "sandbox", "tok-2": "production"}


async def test_test_send_prunes_gone_tokens(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    await register(api_client, "tok-live")
    await register(api_client, "tok-dead")

    sender = FakeSender(outcomes={"tok-dead": SendOutcome.GONE})
    use_sender(sender)
    response = await api_client.post("/v1/notifications/test")

    assert response.status_code == 200
    assert response.json() == {"sent": 1, "pruned": 1}

    remaining = (await db_session.execute(select(DeviceToken))).scalars().all()
    assert [r.token for r in remaining] == ["tok-live"]


async def test_test_send_with_no_devices_is_not_an_error(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)

    sender = FakeSender()
    use_sender(sender)
    response = await api_client.post("/v1/notifications/test")

    assert response.status_code == 200
    assert response.json() == {"sent": 0, "pruned": 0}
    assert sender.sent == []


async def test_test_send_returns_503_when_unconfigured(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    await register(api_client, "tok-1")

    use_sender(FakeSender(configured=False))
    response = await api_client.post("/v1/notifications/test")

    assert response.status_code == 503


async def test_test_send_requires_session(api_client: AsyncClient):
    use_sender(FakeSender())
    response = await api_client.post("/v1/notifications/test")
    assert response.status_code == 401
