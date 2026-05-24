import uuid

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from tests._helpers import make_client, make_user, start_session


async def test_get_user_by_id_returns_profile_for_signed_in_caller(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    target = await make_user(db_session, "viewed.user")

    response = await api_client.get(f"/v1/users/{target.id}/profile")

    assert response.status_code == 200
    assert response.json() == {"id": str(target.id), "username": "viewed.user"}


async def test_get_user_by_id_requires_a_session(
    api_client: AsyncClient, db_session: AsyncSession
):
    target = await make_user(db_session, "lookup.target")
    # Fresh cookie-isolated client so no session cookie is in flight.
    async with make_client() as client:
        response = await client.get(f"/v1/users/{target.id}/profile")
    assert response.status_code == 401
    assert api_client is not None  # keeps the dep-override fixture active


async def test_get_user_by_id_404_when_missing(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    response = await api_client.get(f"/v1/users/{uuid.uuid4()}/profile")
    assert response.status_code == 404


async def test_public_user_by_username_does_not_require_session(
    api_client: AsyncClient, db_session: AsyncSession
):
    target = await make_user(db_session, "public.user")
    async with make_client() as client:
        response = await client.get("/v1/p/users/public.user")
    assert response.status_code == 200
    assert response.json() == {"id": str(target.id), "username": "public.user"}
    # No session cookie should have been minted by the public endpoint.
    assert "session" not in response.cookies
    assert api_client is not None


async def test_public_user_by_username_404_when_missing(
    api_client: AsyncClient, db_session: AsyncSession
):
    async with make_client() as client:
        response = await client.get("/v1/p/users/nobody.here")
    assert response.status_code == 404
    assert api_client is not None
    assert db_session is not None


async def test_public_user_by_username_is_rate_limited_per_ip(
    api_client: AsyncClient, db_session: AsyncSession
):
    """After 60 requests in the same minute from one IP, the 61st returns 429."""
    await make_user(db_session, "rl.target")
    async with make_client() as client:
        for i in range(60):
            response = await client.get("/v1/p/users/rl.target")
            assert response.status_code == 200, (i, response.text)
        over = await client.get("/v1/p/users/rl.target")
    assert over.status_code == 429
    assert api_client is not None
