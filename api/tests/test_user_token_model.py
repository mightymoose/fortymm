import uuid

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import User, UserToken


async def test_create_user_token_assigns_uuid_and_timestamp(db_session: AsyncSession):
    user = User(username="alice")
    db_session.add(user)
    await db_session.commit()

    token = UserToken(
        token=b"secret-bytes",
        context="session",
        sent_to=None,
        user_id=user.id,
    )
    db_session.add(token)
    await db_session.commit()
    await db_session.refresh(token)

    assert isinstance(token.id, uuid.UUID)
    assert token.token == b"secret-bytes"
    assert token.context == "session"
    assert token.sent_to is None
    assert token.user_id == user.id
    assert token.created_at is not None


async def test_user_token_requires_user(db_session: AsyncSession):
    db_session.add(
        UserToken(token=b"x", context="session", user_id=None)  # type: ignore[arg-type]
    )
    with pytest.raises(IntegrityError):
        await db_session.commit()


async def test_user_token_requires_token_and_context(db_session: AsyncSession):
    user = User(username="carol")
    db_session.add(user)
    await db_session.commit()

    db_session.add(
        UserToken(token=None, context="session", user_id=user.id)  # type: ignore[arg-type]
    )
    with pytest.raises(IntegrityError):
        await db_session.commit()


async def test_user_token_cascades_on_user_delete(db_session: AsyncSession):
    user = User(username="dave")
    db_session.add(user)
    await db_session.commit()

    token = UserToken(token=b"t", context="session", user_id=user.id)
    db_session.add(token)
    await db_session.commit()

    token_id = token.id
    await db_session.delete(user)
    await db_session.commit()
    db_session.expunge_all()

    fetched = await db_session.get(UserToken, token_id)
    assert fetched is None
