"""The admin broadcast tool: the permission gate, the recipient picker, and the
preference-respecting fan-out."""

from datetime import UTC, datetime

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    DeviceToken,
    Notification,
    Permission,
    Role,
    RolePermission,
    User,
    UserRole,
)
from app.notifications.service import NotificationService
from app.notifications.taxonomy import NotificationCategory, NotificationChannel
from app.schemas.notification import (
    NotificationCellUpdate,
    NotificationPreferencesUpdate,
)
from tests._helpers import FakeSender, make_user, start_session, use_sender

BROADCAST_PERMISSION = "notifications.broadcast"


async def grant_broadcast(db_session: AsyncSession, user: User) -> None:
    role = Role(name="broadcaster")
    perm = Permission(name=BROADCAST_PERMISSION)
    db_session.add_all([role, perm])
    await db_session.flush()
    db_session.add_all(
        [
            UserRole(user_id=user.id, role_id=role.id),
            RolePermission(role_id=role.id, permission_id=perm.id),
        ]
    )
    await db_session.commit()


async def _stored_for(db_session: AsyncSession, user_id) -> list[Notification]:
    return list(
        (
            await db_session.execute(
                select(Notification).where(Notification.user_id == user_id)
            )
        )
        .scalars()
        .all()
    )


# ----- permission gate ------------------------------------------------------


async def test_broadcast_requires_permission(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    response = await api_client.post(
        "/v1/notifications/broadcast",
        json={
            "recipients": {"mode": "all"},
            "channels": ["in_app"],
            "title": "Hi",
            "body": "Body",
        },
    )
    assert response.status_code == 403


async def test_recipient_picker_requires_permission(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    response = await api_client.get("/v1/notifications/broadcast/recipients")
    assert response.status_code == 403


# ----- fan-out --------------------------------------------------------------


async def test_broadcast_all_records_in_app_for_every_player(
    api_client: AsyncClient, db_session: AsyncSession
):
    admin = await start_session(api_client, db_session)
    await grant_broadcast(db_session, admin)
    alice = await make_user(db_session, "alice")
    use_sender(FakeSender())

    response = await api_client.post(
        "/v1/notifications/broadcast",
        json={
            "recipients": {"mode": "all"},
            "channels": ["in_app"],
            "title": "Spring Open — R16 is live",
            "body": "Brackets just dropped.",
        },
    )

    assert response.status_code == 200
    data = response.json()
    # Two live users: the admin and alice.
    assert data["recipients"] == 2
    assert data["in_app_created"] == 2
    assert data["pushed"] == 0
    alice_feed = await _stored_for(db_session, alice.id)
    assert [(n.title, n.category) for n in alice_feed] == [
        ("Spring Open — R16 is live", "tournament")
    ]


async def test_broadcast_all_excludes_tombstoned_users(
    api_client: AsyncClient, db_session: AsyncSession
):
    admin = await start_session(api_client, db_session)
    await grant_broadcast(db_session, admin)
    ghost = await make_user(db_session, "ghost")
    ghost.merged_into_user_id = admin.id
    ghost.merged_at = datetime.now(UTC)
    await db_session.commit()
    use_sender(FakeSender())

    response = await api_client.post(
        "/v1/notifications/broadcast",
        json={
            "recipients": {"mode": "all"},
            "channels": ["in_app"],
            "title": "Everyone",
            "body": "…except the ghost.",
        },
    )

    assert response.status_code == 200
    # Only the live admin counts — the tombstoned guest is excluded.
    assert response.json()["recipients"] == 1
    assert await _stored_for(db_session, ghost.id) == []


async def test_broadcast_selected_targets_only_those_players(
    api_client: AsyncClient, db_session: AsyncSession
):
    admin = await start_session(api_client, db_session)
    await grant_broadcast(db_session, admin)
    alice = await make_user(db_session, "alice")
    bob = await make_user(db_session, "bob")
    use_sender(FakeSender())

    response = await api_client.post(
        "/v1/notifications/broadcast",
        json={
            "recipients": {"mode": "selected", "user_ids": [str(alice.id)]},
            "channels": ["in_app"],
            "title": "Heads up",
            "body": "Just you.",
        },
    )

    assert response.status_code == 200
    assert response.json()["recipients"] == 1
    assert len(await _stored_for(db_session, alice.id)) == 1
    assert await _stored_for(db_session, bob.id) == []
    assert await _stored_for(db_session, admin.id) == []


async def test_broadcast_respects_recipient_preferences(
    api_client: AsyncClient, db_session: AsyncSession
):
    admin = await start_session(api_client, db_session)
    await grant_broadcast(db_session, admin)
    alice = await make_user(db_session, "alice")
    # Alice muted tournament news in-app.
    await NotificationService(db_session, FakeSender()).update_preferences(
        alice,
        NotificationPreferencesUpdate(
            cells=[
                NotificationCellUpdate(
                    category=NotificationCategory.TOURNAMENT,
                    channel=NotificationChannel.IN_APP,
                    enabled=False,
                )
            ]
        ),
    )
    use_sender(FakeSender())

    response = await api_client.post(
        "/v1/notifications/broadcast",
        json={
            "recipients": {"mode": "selected", "user_ids": [str(alice.id)]},
            "channels": ["in_app"],
            "title": "Muted for alice",
            "body": "She won't see this in her feed.",
        },
    )

    assert response.status_code == 200
    data = response.json()
    assert data["recipients"] == 1
    assert data["in_app_created"] == 0
    assert await _stored_for(db_session, alice.id) == []


async def test_broadcast_pushes_to_devices(
    api_client: AsyncClient, db_session: AsyncSession
):
    admin = await start_session(api_client, db_session)
    await grant_broadcast(db_session, admin)
    alice = await make_user(db_session, "alice")
    db_session.add(
        DeviceToken(
            token="alice-device",
            platform="ios",
            environment="sandbox",
            user_id=alice.id,
        )
    )
    await db_session.commit()
    sender = FakeSender()
    use_sender(sender)

    response = await api_client.post(
        "/v1/notifications/broadcast",
        json={
            "recipients": {"mode": "selected", "user_ids": [str(alice.id)]},
            "channels": ["push"],
            "title": "Court change",
            "body": "Your QF moved to Court 1.",
        },
    )

    assert response.status_code == 200
    data = response.json()
    assert data["pushed"] == 1
    assert data["in_app_created"] == 0
    assert [p.token for p in sender.sent] == ["alice-device"]


# ----- recipient picker -----------------------------------------------------


async def test_recipient_picker_search(
    api_client: AsyncClient, db_session: AsyncSession
):
    admin = await start_session(api_client, db_session)
    # The admin's auto-generated coolname could itself contain "al" (e.g.
    # "large-teal"), so pin it to a name the search query can't match.
    admin.username = "broadcaster"
    await db_session.commit()
    await grant_broadcast(db_session, admin)
    await make_user(db_session, "alice")
    await make_user(db_session, "alvin")
    await make_user(db_session, "bob")

    response = await api_client.get("/v1/notifications/broadcast/recipients?q=al")

    assert response.status_code == 200
    data = response.json()
    usernames = sorted(r["username"] for r in data["recipients"])
    assert usernames == ["alice", "alvin"]
    assert data["total"] == 2


async def test_recipient_picker_excludes_tombstoned_users(
    api_client: AsyncClient, db_session: AsyncSession
):
    admin = await start_session(api_client, db_session)
    await grant_broadcast(db_session, admin)
    ghost = await make_user(db_session, "ghost")
    ghost.merged_into_user_id = admin.id
    ghost.merged_at = datetime.now(UTC)
    await db_session.commit()

    response = await api_client.get("/v1/notifications/broadcast/recipients")

    assert response.status_code == 200
    usernames = {r["username"] for r in response.json()["recipients"]}
    assert "ghost" not in usernames
    assert admin.username in usernames


# ----- validation -----------------------------------------------------------


async def test_broadcast_rejects_empty_channels(
    api_client: AsyncClient, db_session: AsyncSession
):
    admin = await start_session(api_client, db_session)
    await grant_broadcast(db_session, admin)
    response = await api_client.post(
        "/v1/notifications/broadcast",
        json={
            "recipients": {"mode": "all"},
            "channels": [],
            "title": "Hi",
            "body": "Body",
        },
    )
    assert response.status_code == 422


async def test_broadcast_rejects_selected_with_no_ids(
    api_client: AsyncClient, db_session: AsyncSession
):
    admin = await start_session(api_client, db_session)
    await grant_broadcast(db_session, admin)
    response = await api_client.post(
        "/v1/notifications/broadcast",
        json={
            "recipients": {"mode": "selected", "user_ids": []},
            "channels": ["in_app"],
            "title": "Hi",
            "body": "Body",
        },
    )
    assert response.status_code == 422
