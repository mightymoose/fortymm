import uuid

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Player, User


async def test_create_user_assigns_uuid_and_timestamps(db_session: AsyncSession):
    user = User(username="alice")
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    assert isinstance(user.id, uuid.UUID)
    assert user.created_at is not None
    assert user.updated_at is not None


async def test_username_is_unique(db_session: AsyncSession):
    db_session.add(User(username="bob"))
    await db_session.commit()
    db_session.add(User(username="bob"))
    with pytest.raises(IntegrityError):
        await db_session.commit()


async def test_player_username_is_required(db_session: AsyncSession):
    db_session.add(Player(username=None))  # type: ignore[arg-type]
    with pytest.raises(IntegrityError):
        await db_session.commit()


async def test_email_defaults_to_null_and_is_unique(db_session: AsyncSession):
    u = User(username="claire")
    db_session.add(u)
    await db_session.commit()
    await db_session.refresh(u)
    assert u.email is None
    assert u.confirmed_at is None

    db_session.add(User(username="dave", email="dup@example.com"))
    await db_session.commit()
    db_session.add(User(username="erin", email="dup@example.com"))
    with pytest.raises(IntegrityError):
        await db_session.commit()


async def test_auth0_sub_defaults_to_null_and_round_trips(db_session: AsyncSession):
    u = User(username="frank")
    db_session.add(u)
    await db_session.commit()
    await db_session.refresh(u)
    assert u.auth0_sub is None

    u.auth0_sub = "auth0|abc123"
    await db_session.commit()
    await db_session.refresh(u)
    assert u.auth0_sub == "auth0|abc123"


async def test_auth0_sub_is_unique(db_session: AsyncSession):
    db_session.add(User(username="grace", auth0_sub="auth0|dup"))
    await db_session.commit()
    db_session.add(User(username="heidi", auth0_sub="auth0|dup"))
    with pytest.raises(IntegrityError):
        await db_session.commit()
