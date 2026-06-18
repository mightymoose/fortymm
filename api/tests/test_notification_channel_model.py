"""The notification_channels lookup table: it's seeded (one row per channel,
sms unavailable), its key is unique, and the channel-column FKs reference it."""

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import NotificationChannel, NotificationChannelSetting
from app.notifications.taxonomy import NotificationChannel as ChannelEnum
from tests._helpers import make_user


async def test_seeded_rows_cover_every_channel(db_session: AsyncSession):
    rows = (await db_session.execute(select(NotificationChannel))).scalars().all()
    by_key = {row.key: row for row in rows}
    assert set(by_key) == {c.value for c in ChannelEnum}

    sample = rows[0]
    assert isinstance(sample.id, uuid.UUID)
    assert sample.created_at is not None
    assert sample.updated_at is not None

    # sms is present but not deliverable; the rest are available.
    assert by_key["sms"].is_available is False
    assert by_key["in_app"].is_available is True
    assert by_key["push"].is_available is True
    assert by_key["email"].is_available is True


async def test_key_is_unique(db_session: AsyncSession):
    # in_app is already seeded by the autouse fixture.
    db_session.add(NotificationChannel(key="in_app", name="dupe"))
    with pytest.raises(IntegrityError):
        await db_session.commit()


async def test_channel_setting_must_reference_a_channel(db_session: AsyncSession):
    user = await make_user(db_session, "fk-channel")
    db_session.add(
        NotificationChannelSetting(
            user_id=user.id, channel="carrier_pigeon", enabled=True
        )
    )
    with pytest.raises(IntegrityError):
        await db_session.commit()


async def test_known_channel_inserts_cleanly(db_session: AsyncSession):
    user = await make_user(db_session, "fk-channel-ok")
    db_session.add(
        NotificationChannelSetting(
            user_id=user.id, channel=ChannelEnum.PUSH.value, enabled=False
        )
    )
    await db_session.commit()
