"""The admin broadcast tool: the permission gate, the recipient picker, and the
background fan-out (one delivery job enqueued per resolved recipient)."""

from datetime import UTC, datetime

from httpx import AsyncClient
from rq import Queue
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Permission,
    Role,
    RolePermission,
    User,
    UserRole,
)
from tests._helpers import (
    FakeSender,
    enqueued_notification_jobs,
    make_user,
    start_session,
    use_sender,
)

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


# ----- permission gate ------------------------------------------------------


async def test_broadcast_requires_permission(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    response = await api_client.post(
        "/v1/notifications/broadcast",
        json={"recipients": {"mode": "all"}, "title": "Hi", "body": "Body"},
    )
    assert response.status_code == 403


async def test_recipient_picker_requires_permission(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    response = await api_client.get("/v1/notifications/broadcast/recipients")
    assert response.status_code == 403


# ----- fan-out --------------------------------------------------------------


async def test_broadcast_all_enqueues_a_job_for_every_player(
    api_client: AsyncClient,
    db_session: AsyncSession,
    fake_notifications_queue: Queue,
):
    admin = await start_session(api_client, db_session)
    await grant_broadcast(db_session, admin)
    alice = await make_user(db_session, "alice")
    use_sender(FakeSender())

    response = await api_client.post(
        "/v1/notifications/broadcast",
        json={
            "recipients": {"mode": "all"},
            "title": "Spring Open — R16 is live",
            "body": "Brackets just dropped.",
        },
    )

    assert response.status_code == 200
    data = response.json()
    # Two live users: the admin and alice.
    assert data == {"recipients": 2, "queued": True}
    jobs = enqueued_notification_jobs(fake_notifications_queue)
    assert {job.user_id for job in jobs} == {admin.id, alice.id}
    assert all(job.category.value == "tournament" for job in jobs)
    assert all(job.title == "Spring Open — R16 is live" for job in jobs)


async def test_broadcast_all_excludes_tombstoned_users(
    api_client: AsyncClient,
    db_session: AsyncSession,
    fake_notifications_queue: Queue,
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
            "title": "Everyone",
            "body": "…except the ghost.",
        },
    )

    assert response.status_code == 200
    # Only the live admin counts — the tombstoned guest is excluded.
    assert response.json()["recipients"] == 1
    jobs = enqueued_notification_jobs(fake_notifications_queue)
    assert [job.user_id for job in jobs] == [admin.id]


async def test_broadcast_selected_targets_only_those_players(
    api_client: AsyncClient,
    db_session: AsyncSession,
    fake_notifications_queue: Queue,
):
    admin = await start_session(api_client, db_session)
    await grant_broadcast(db_session, admin)
    alice = await make_user(db_session, "alice")
    await make_user(db_session, "bob")
    use_sender(FakeSender())

    response = await api_client.post(
        "/v1/notifications/broadcast",
        json={
            "recipients": {"mode": "selected", "user_ids": [str(alice.id)]},
            "title": "Heads up",
            "body": "Just you.",
        },
    )

    assert response.status_code == 200
    assert response.json()["recipients"] == 1
    jobs = enqueued_notification_jobs(fake_notifications_queue)
    assert [job.user_id for job in jobs] == [alice.id]


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


async def test_broadcast_rejects_unknown_channels_field(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The admin no longer picks channels — preferences decide. A stray
    ``channels`` key is a client bug (extra="forbid")."""
    admin = await start_session(api_client, db_session)
    await grant_broadcast(db_session, admin)
    response = await api_client.post(
        "/v1/notifications/broadcast",
        json={
            "recipients": {"mode": "all"},
            "channels": ["in_app"],
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
            "title": "Hi",
            "body": "Body",
        },
    )
    assert response.status_code == 422
