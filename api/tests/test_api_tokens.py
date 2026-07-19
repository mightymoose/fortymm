"""POST /v1/api-tokens — mint an opaque personal API token (issue #1130).

Covers the rotate-on-create contract: a permission-holding user gets a 201 with
a raw token that is stored only as its hash; a second POST rotates to a new
token leaving exactly one ``api``-context row; the rotate never touches the
user's other-context (session / login) tokens; and a user without the
permission is refused with 403.
"""

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api_tokens import API_TOKEN_PERMISSION
from app.models import UserToken
from app.sessions import API_TOKEN_CONTEXT, _hash_token
from tests._helpers import grant_permissions, start_session


async def _api_tokens(db: AsyncSession, user_id: object) -> list[UserToken]:
    result = await db.execute(
        select(UserToken).where(
            UserToken.user_id == user_id,
            UserToken.context == API_TOKEN_CONTEXT,
        )
    )
    return list(result.scalars().all())


async def test_mint_returns_token_stored_only_as_hash(
    api_client: AsyncClient, db_session: AsyncSession
) -> None:
    user = await start_session(api_client, db_session)
    await grant_permissions(db_session, user, [API_TOKEN_PERMISSION])

    response = await api_client.post("/v1/api-tokens")

    assert response.status_code == 201, response.text
    raw = response.json()["token"]
    assert isinstance(raw, str)
    assert raw

    rows = await _api_tokens(db_session, user.id)
    assert len(rows) == 1
    # Stored as the sha256 hash, never the plaintext.
    assert rows[0].token == _hash_token(raw)
    assert rows[0].token != raw.encode("utf-8")


async def test_second_mint_rotates_to_a_new_single_token(
    api_client: AsyncClient, db_session: AsyncSession
) -> None:
    user = await start_session(api_client, db_session)
    await grant_permissions(db_session, user, [API_TOKEN_PERMISSION])

    first = (await api_client.post("/v1/api-tokens")).json()["token"]
    second_response = await api_client.post("/v1/api-tokens")

    assert second_response.status_code == 201, second_response.text
    second = second_response.json()["token"]
    assert second != first

    rows = await _api_tokens(db_session, user.id)
    assert len(rows) == 1
    assert rows[0].token == _hash_token(second)


async def test_rotate_leaves_other_context_tokens_untouched(
    api_client: AsyncClient, db_session: AsyncSession
) -> None:
    user = await start_session(api_client, db_session)
    await grant_permissions(db_session, user, [API_TOKEN_PERMISSION])

    # Seed the user with non-api-context tokens that a rotate must NOT delete.
    session_token = UserToken(
        user_id=user.id, context="session", token=_hash_token("sess-raw")
    )
    login_token = UserToken(
        user_id=user.id, context="login", token=_hash_token("login-raw")
    )
    db_session.add_all([session_token, login_token])
    await db_session.commit()

    # start_session itself already minted a real session token for this user;
    # capture the full non-api set so we can prove every one survives.
    before = (
        (
            await db_session.execute(
                select(UserToken.id).where(
                    UserToken.user_id == user.id,
                    UserToken.context != API_TOKEN_CONTEXT,
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(before) >= 2

    response = await api_client.post("/v1/api-tokens")
    assert response.status_code == 201, response.text

    after = (
        (
            await db_session.execute(
                select(UserToken.id).where(
                    UserToken.user_id == user.id,
                    UserToken.context != API_TOKEN_CONTEXT,
                )
            )
        )
        .scalars()
        .all()
    )
    assert set(after) == set(before)

    # And exactly one api-context token now exists.
    assert len(await _api_tokens(db_session, user.id)) == 1


async def test_without_permission_forbidden(
    api_client: AsyncClient, db_session: AsyncSession
) -> None:
    # A signed-in user who was never granted api_token.manage.
    await start_session(api_client, db_session)

    response = await api_client.post("/v1/api-tokens")

    assert response.status_code == 403, response.text
