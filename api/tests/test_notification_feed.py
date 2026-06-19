"""The persisted in-app feed: list, unread count, mark-read, mark-all-read."""

import uuid
from datetime import UTC, datetime, timedelta

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Notification
from tests._helpers import make_user, start_session


async def make_notification(
    db_session: AsyncSession,
    user_id: uuid.UUID,
    *,
    title: str = "Notification",
    body: str = "Body",
    category: str = "tournament",
    read: bool = False,
    created_at: datetime | None = None,
) -> Notification:
    notification = Notification(
        user_id=user_id,
        category=category,
        title=title,
        body=body,
        read_at=datetime.now(UTC) if read else None,
        created_at=created_at or datetime.now(UTC),
    )
    db_session.add(notification)
    await db_session.commit()
    await db_session.refresh(notification)
    return notification


async def test_feed_lists_newest_first_with_unread_count(
    api_client: AsyncClient, db_session: AsyncSession
):
    user = await start_session(api_client, db_session)
    now = datetime.now(UTC)
    await make_notification(
        db_session, user.id, title="old", read=True, created_at=now - timedelta(hours=2)
    )
    await make_notification(
        db_session, user.id, title="mid", created_at=now - timedelta(hours=1)
    )
    await make_notification(db_session, user.id, title="new", created_at=now)

    response = await api_client.get("/v1/notifications")

    assert response.status_code == 200
    data = response.json()
    assert [item["title"] for item in data["items"]] == ["new", "mid", "old"]
    assert data["unread_count"] == 2
    assert data["items"][0]["read_at"] is None
    assert data["items"][-1]["read_at"] is not None


async def test_feed_only_returns_callers_notifications(
    api_client: AsyncClient, db_session: AsyncSession
):
    user = await start_session(api_client, db_session)
    other = await make_user(db_session, "someone-else")
    await make_notification(db_session, user.id, title="mine")
    await make_notification(db_session, other.id, title="theirs")

    response = await api_client.get("/v1/notifications")

    assert response.status_code == 200
    data = response.json()
    assert [item["title"] for item in data["items"]] == ["mine"]
    assert data["unread_count"] == 1


async def test_unread_count_endpoint(api_client: AsyncClient, db_session: AsyncSession):
    user = await start_session(api_client, db_session)
    await make_notification(db_session, user.id, read=False)
    await make_notification(db_session, user.id, read=False)
    await make_notification(db_session, user.id, read=True)

    response = await api_client.get("/v1/notifications/unread-count")

    assert response.status_code == 200
    assert response.json() == {"unread_count": 2}


async def test_mark_one_read(api_client: AsyncClient, db_session: AsyncSession):
    user = await start_session(api_client, db_session)
    notification = await make_notification(db_session, user.id, read=False)

    response = await api_client.post(f"/v1/notifications/{notification.id}/read")

    assert response.status_code == 200
    assert response.json()["read_at"] is not None
    after = await api_client.get("/v1/notifications/unread-count")
    assert after.json() == {"unread_count": 0}


async def test_mark_read_is_idempotent(
    api_client: AsyncClient, db_session: AsyncSession
):
    user = await start_session(api_client, db_session)
    notification = await make_notification(db_session, user.id, read=False)

    first = await api_client.post(f"/v1/notifications/{notification.id}/read")
    read_at = first.json()["read_at"]
    second = await api_client.post(f"/v1/notifications/{notification.id}/read")

    assert second.status_code == 200
    # The timestamp is stable — re-marking doesn't re-stamp.
    assert second.json()["read_at"] == read_at


async def test_cannot_mark_another_users_notification(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    other = await make_user(db_session, "victim")
    notification = await make_notification(db_session, other.id)

    response = await api_client.post(f"/v1/notifications/{notification.id}/read")

    assert response.status_code == 404
    # And it stays unread.
    still = (
        await db_session.execute(
            select(Notification).where(Notification.id == notification.id)
        )
    ).scalar_one()
    assert still.read_at is None


async def test_mark_missing_notification_404(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    response = await api_client.post(f"/v1/notifications/{uuid.uuid4()}/read")
    assert response.status_code == 404


async def test_mark_batch_read(api_client: AsyncClient, db_session: AsyncSession):
    user = await start_session(api_client, db_session)
    a = await make_notification(db_session, user.id, read=False)
    b = await make_notification(db_session, user.id, read=False)
    await make_notification(db_session, user.id, read=False)

    response = await api_client.post(
        "/v1/notifications/read", json={"ids": [str(a.id), str(b.id)]}
    )

    assert response.status_code == 200
    assert response.json() == {"marked": 2}
    # Only the two named were flipped; the third stays unread.
    after = await api_client.get("/v1/notifications/unread-count")
    assert after.json() == {"unread_count": 1}


async def test_mark_batch_skips_foreign_already_read_and_missing(
    api_client: AsyncClient, db_session: AsyncSession
):
    user = await start_session(api_client, db_session)
    other = await make_user(db_session, "someone-else")
    mine_unread = await make_notification(db_session, user.id, read=False)
    mine_read = await make_notification(db_session, user.id, read=True)
    theirs = await make_notification(db_session, other.id, read=False)

    response = await api_client.post(
        "/v1/notifications/read",
        json={
            "ids": [
                str(mine_unread.id),
                str(mine_read.id),
                str(theirs.id),
                str(uuid.uuid4()),
            ]
        },
    )

    assert response.status_code == 200
    # Only the caller's still-unread row counts; foreign/read/missing are skipped.
    assert response.json() == {"marked": 1}
    still_theirs = (
        await db_session.execute(
            select(Notification).where(Notification.id == theirs.id)
        )
    ).scalar_one()
    assert still_theirs.read_at is None


async def test_mark_batch_rejects_empty_ids(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    response = await api_client.post("/v1/notifications/read", json={"ids": []})
    assert response.status_code == 422


async def test_mark_all_read(api_client: AsyncClient, db_session: AsyncSession):
    user = await start_session(api_client, db_session)
    await make_notification(db_session, user.id, read=False)
    await make_notification(db_session, user.id, read=False)
    await make_notification(db_session, user.id, read=True)

    response = await api_client.post("/v1/notifications/read-all")

    assert response.status_code == 200
    # Only the two unread ones were flipped.
    assert response.json() == {"marked": 2}
    after = await api_client.get("/v1/notifications/unread-count")
    assert after.json() == {"unread_count": 0}


async def test_feed_requires_session(api_client: AsyncClient):
    assert (await api_client.get("/v1/notifications")).status_code == 401
    assert (await api_client.get("/v1/notifications/unread-count")).status_code == 401
    assert (await api_client.post("/v1/notifications/read-all")).status_code == 401
    assert (
        await api_client.post(
            "/v1/notifications/read", json={"ids": [str(uuid.uuid4())]}
        )
    ).status_code == 401


async def test_unknown_user_feed_is_independent(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A freshly-minted session has an empty feed."""
    await start_session(api_client, db_session)
    response = await api_client.get("/v1/notifications")
    assert response.status_code == 200
    assert response.json() == {"items": [], "unread_count": 0}
