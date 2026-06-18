"""The notification_types lookup table: it's seeded (one row per category), its
key is unique, and the notifications.category FK references it."""

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Notification, NotificationType, User
from app.notifications.taxonomy import NotificationCategory
from tests._helpers import make_user


async def test_seeded_rows_cover_every_category(db_session: AsyncSession):
    rows = (await db_session.execute(select(NotificationType))).scalars().all()
    assert {row.key for row in rows} == {c.value for c in NotificationCategory}
    sample = rows[0]
    assert isinstance(sample.id, uuid.UUID)
    assert sample.created_at is not None
    assert sample.updated_at is not None
    assert sample.display_order >= 1
    assert sample.is_active is True


async def test_key_is_unique(db_session: AsyncSession):
    # match_reminder is already seeded by the autouse fixture.
    db_session.add(
        NotificationType(key="match_reminder", name="dupe", short_label="dupe")
    )
    with pytest.raises(IntegrityError):
        await db_session.commit()


async def test_notification_category_must_reference_a_type(db_session: AsyncSession):
    user = await make_user(db_session, "fk-type")
    db_session.add(
        Notification(
            user_id=user.id,
            category="not_a_real_category",
            title="x",
            body="y",
        )
    )
    with pytest.raises(IntegrityError):
        await db_session.commit()


async def test_known_category_inserts_cleanly(db_session: AsyncSession):
    user: User = await make_user(db_session, "fk-type-ok")
    db_session.add(
        Notification(
            user_id=user.id,
            category=NotificationCategory.RESULT_CONFIRM.value,
            title="x",
            body="y",
        )
    )
    await db_session.commit()
