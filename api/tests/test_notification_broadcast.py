"""The admin broadcast tool: the permission gate, the recipient picker, and the
background fan-out (one delivery job enqueued per resolved recipient)."""

from datetime import UTC, datetime

import pytest
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


async def test_broadcast_files_under_the_chosen_category(
    api_client: AsyncClient,
    db_session: AsyncSession,
    fake_notifications_queue: Queue,
):
    admin = await start_session(api_client, db_session)
    await grant_broadcast(db_session, admin)
    use_sender(FakeSender())

    response = await api_client.post(
        "/v1/notifications/broadcast",
        json={
            "recipients": {"mode": "all"},
            "category": "rating_change",
            "title": "New season ratings",
            "body": "Your rating moved.",
        },
    )

    assert response.status_code == 200
    jobs = enqueued_notification_jobs(fake_notifications_queue)
    assert jobs
    assert all(job.category.value == "rating_change" for job in jobs)


async def test_broadcast_defaults_to_tournament_when_category_omitted(
    api_client: AsyncClient,
    db_session: AsyncSession,
    fake_notifications_queue: Queue,
):
    admin = await start_session(api_client, db_session)
    await grant_broadcast(db_session, admin)
    use_sender(FakeSender())

    response = await api_client.post(
        "/v1/notifications/broadcast",
        json={"recipients": {"mode": "all"}, "title": "Hi", "body": "Body"},
    )

    assert response.status_code == 200
    jobs = enqueued_notification_jobs(fake_notifications_queue)
    assert all(job.category.value == "tournament" for job in jobs)


async def test_broadcast_rejects_an_unknown_category(
    api_client: AsyncClient, db_session: AsyncSession
):
    admin = await start_session(api_client, db_session)
    await grant_broadcast(db_session, admin)
    response = await api_client.post(
        "/v1/notifications/broadcast",
        json={
            "recipients": {"mode": "all"},
            "category": "not_a_category",
            "title": "Hi",
            "body": "Body",
        },
    )
    assert response.status_code == 422


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


async def _lifecycle_audience(db_session):
    from app.identity_lifecycle import deactivate_account, erase_account, retire_player

    active = await make_user(db_session, "audience-active")
    retired = await make_user(db_session, "audience-retired")
    suspended = await make_user(db_session, "audience-suspended")
    erased = await make_user(db_session, "audience-erased")
    await retire_player(db_session, retired.player_id)
    await deactivate_account(db_session, suspended.id)
    await erase_account(db_session, erased.id)
    await db_session.commit()
    return active, retired, suspended, erased


@pytest.mark.parametrize("mode", ["all", "selected"])
async def test_broadcast_counts_only_active_accounts_including_retired_players(
    api_client, db_session, fake_notifications_queue, mode
):
    admin = await start_session(api_client, db_session)
    await grant_broadcast(db_session, admin)
    audience = await _lifecycle_audience(db_session)
    recipients = {"mode": mode}
    if mode == "selected":
        recipients["user_ids"] = [str(user.id) for user in audience]
    response = await api_client.post(
        "/v1/notifications/broadcast",
        json={
            "recipients": recipients,
            "title": "Existing competition",
            "body": "Update",
        },
    )
    assert response.status_code == 200, response.text
    expected = {audience[0].id, audience[1].id}
    if mode == "all":
        expected.add(admin.id)
    assert response.json()["recipients"] == len(expected)
    assert {
        job.user_id for job in enqueued_notification_jobs(fake_notifications_queue)
    } == expected


@pytest.mark.parametrize(
    "query", [None, "audience-", "audience-suspended", "audience-erased"]
)
async def test_recipient_picker_and_total_follow_account_activity(
    api_client, db_session, query
):
    admin = await start_session(api_client, db_session)
    admin.username = "broadcaster"
    await db_session.commit()
    await grant_broadcast(db_session, admin)
    active, retired, _, _ = await _lifecycle_audience(db_session)
    response = await api_client.get(
        "/v1/notifications/broadcast/recipients",
        params={"q": query} if query else {},
    )
    assert response.status_code == 200, response.text
    expected = (
        {str(active.id), str(retired.id)} if query in (None, "audience-") else set()
    )
    if query is None:
        expected.add(str(admin.id))
    payload = response.json()
    assert payload["total"] == len(expected)
    assert {recipient["id"] for recipient in payload["recipients"]} == expected
