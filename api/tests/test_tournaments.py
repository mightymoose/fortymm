"""Endpoint tests for the tournaments router.

Unlike test_rbac (which bypasses the authz gate via dependency_overrides),
these tests exercise the *real* permission gate: each client establishes a
genuine session via ``GET /v1/session`` and is granted ``tournament.manage`` by
inserting real Permission/Role/RolePermission/UserRole rows. Mutating requests
carry the double-submit CSRF token via ``CSRF_EVENT_HOOKS`` (baked into both the
``api_client`` fixture and ``make_client``).
"""

from collections.abc import AsyncIterator
from typing import Any

import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Permission,
    Role,
    RolePermission,
    Tournament,
    User,
    UserRole,
)
from app.tournaments import TOURNAMENT_PERMISSION
from tests._helpers import make_client, start_session


async def _grant_tournament_manage(db_session: AsyncSession, user: User) -> None:
    """Grant ``tournament.manage`` to ``user`` via real RBAC rows, reusing the
    permission/role if a prior call already created them in this test."""
    permission = (
        await db_session.execute(
            select(Permission).where(Permission.name == TOURNAMENT_PERMISSION)
        )
    ).scalar_one_or_none()
    if permission is None:
        permission = Permission(
            name=TOURNAMENT_PERMISSION, description="Create and manage tournaments."
        )
        db_session.add(permission)
        await db_session.flush()

    role = (
        await db_session.execute(select(Role).where(Role.name == "Beta tester"))
    ).scalar_one_or_none()
    if role is None:
        role = Role(name="Beta tester", description="Early-access testers.")
        db_session.add(role)
        await db_session.flush()
        db_session.add(RolePermission(role_id=role.id, permission_id=permission.id))

    db_session.add(UserRole(user_id=user.id, role_id=role.id))
    await db_session.commit()


@pytest_asyncio.fixture
async def authed_client(
    api_client: AsyncClient, db_session: AsyncSession
) -> AsyncIterator[tuple[AsyncClient, User]]:
    """The primary ``api_client`` with a real session whose user holds
    ``tournament.manage``."""
    user = await start_session(api_client, db_session)
    await _grant_tournament_manage(db_session, user)
    yield api_client, user


def _address() -> dict[str, str]:
    return {
        "venue": "Berkeley TT Club",
        "street": "2727 Milvia St",
        "city": "Berkeley",
        "region": "CA",
        "postal": "94703",
        "country": "USA",
    }


def _create_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "name": "Bay Area Open 2026",
        "description": "Two-day open. USATT-sanctioned.",
        "start_date": "2026-06-13",
        "end_date": "2026-06-14",
        "address": _address(),
        "table_catalogue": [
            {"id": "t1", "label": "Table 1", "court": "A"},
            {"id": "t2", "label": "Table 2", "court": "A"},
        ],
    }
    payload.update(overrides)
    return payload


def _event_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "name": "Open Singles",
        "format": "singles",
        "draw_type": "rr-then-ko",
        "max_players": 64,
        "entry_fee": 45,
        "entered": 52,
        "slot": {"date": "2026-06-13", "start": "09:00", "end": "18:00"},
        "match_settings": {"rated": True, "length_games": 5},
        "predicates": [{"id": "pr-1", "field": "rating", "op": "<", "value": 1500}],
        "pools": [
            {
                "id": "p-os-1",
                "name": "Pool A",
                "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
                "table_ids": ["t1", "t2"],
            }
        ],
    }
    payload.update(overrides)
    return payload


# ----- tournament happy path -----------------------------------------------


async def test_create_tournament_returns_201(
    authed_client: tuple[AsyncClient, User],
):
    client, user = authed_client
    response = await client.post("/v1/tournaments", json=_create_payload())
    assert response.status_code == 201
    body = response.json()
    assert body["id"]
    assert body["name"] == "Bay Area Open 2026"
    assert body["description"] == "Two-day open. USATT-sanctioned."
    assert body["status"] == "draft"
    assert body["start_date"] == "2026-06-13"
    assert body["end_date"] == "2026-06-14"
    assert body["address"] == _address()
    assert body["table_catalogue"] == [
        {"id": "t1", "label": "Table 1", "court": "A"},
        {"id": "t2", "label": "Table 2", "court": "A"},
    ]
    assert body["can_edit"] is True
    assert body["created_by_username"] == user.username
    assert body["created_by_user_id"] == str(user.id)


async def test_create_with_published_status_emits_wire_value(
    authed_client: tuple[AsyncClient, User],
):
    client, _ = authed_client
    response = await client.post(
        "/v1/tournaments", json=_create_payload(status="published")
    )
    assert response.status_code == 201
    assert response.json()["status"] == "published"


async def test_list_includes_created_tournament_with_can_edit(
    authed_client: tuple[AsyncClient, User],
):
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    # The list page's cards render event-derived stats, so the list returns the
    # full aggregate (events included) — add one so we can assert it shows up.
    event = (
        await client.post(
            f"/v1/tournaments/{created['id']}/events", json=_event_payload()
        )
    ).json()

    listing = await client.get("/v1/tournaments")
    assert listing.status_code == 200
    rows = listing.json()
    match = next(r for r in rows if r["id"] == created["id"])
    assert match["can_edit"] is True
    # The list item carries the tournament's events so the cards can show counts.
    assert [e["id"] for e in match["events"]] == [event["id"]]


async def test_get_existing_returns_detail_with_empty_events(
    authed_client: tuple[AsyncClient, User],
):
    client, user = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()

    response = await client.get(f"/v1/tournaments/{created['id']}")
    assert response.status_code == 200
    body = response.json()
    assert body["id"] == created["id"]
    assert body["created_by_username"] == user.username
    assert body["can_edit"] is True
    assert body["events"] == []


async def test_get_missing_returns_404(
    authed_client: tuple[AsyncClient, User],
):
    client, _ = authed_client
    response = await client.get("/v1/tournaments/00000000-0000-0000-0000-000000000000")
    assert response.status_code == 404


async def test_patch_by_creator_updates_fields(
    authed_client: tuple[AsyncClient, User],
):
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()

    new_address = {**_address(), "venue": "Palo Alto Community Center"}
    response = await client.patch(
        f"/v1/tournaments/{created['id']}",
        json={
            "name": "Bay Area Major",
            "status": "live",
            "start_date": "2026-08-01",
            "end_date": "2026-08-02",
            "address": new_address,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "Bay Area Major"
    assert body["status"] == "live"
    assert body["start_date"] == "2026-08-01"
    assert body["end_date"] == "2026-08-02"
    assert body["address"] == new_address


async def test_patch_explicit_null_name_returns_422(
    authed_client: tuple[AsyncClient, User],
):
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    response = await client.patch(
        f"/v1/tournaments/{created['id']}", json={"name": None}
    )
    assert response.status_code == 422


async def test_patch_explicit_null_status_returns_422(
    authed_client: tuple[AsyncClient, User],
):
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    response = await client.patch(
        f"/v1/tournaments/{created['id']}", json={"status": None}
    )
    assert response.status_code == 422


async def test_patch_explicit_null_address_returns_422(
    authed_client: tuple[AsyncClient, User],
):
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    response = await client.patch(
        f"/v1/tournaments/{created['id']}", json={"address": None}
    )
    assert response.status_code == 422


async def test_patch_explicit_null_table_catalogue_returns_422(
    authed_client: tuple[AsyncClient, User],
):
    # table_catalogue is a NOT NULL column — an explicit null is a 422, not a 500.
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    response = await client.patch(
        f"/v1/tournaments/{created['id']}", json={"table_catalogue": None}
    )
    assert response.status_code == 422


async def test_delete_by_creator_removes_row(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
):
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()

    response = await client.delete(f"/v1/tournaments/{created['id']}")
    assert response.status_code == 204

    remaining = (
        await db_session.execute(
            select(Tournament).where(Tournament.id == created["id"])
        )
    ).scalar_one_or_none()
    assert remaining is None


async def test_create_rejects_unknown_field(
    authed_client: tuple[AsyncClient, User],
):
    client, _ = authed_client
    response = await client.post("/v1/tournaments", json=_create_payload(bogus="nope"))
    assert response.status_code == 422


# ----- event happy path ----------------------------------------------------


async def test_create_event_round_trips_jsonb(
    authed_client: tuple[AsyncClient, User],
):
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()

    response = await client.post(
        f"/v1/tournaments/{created['id']}/events", json=_event_payload()
    )
    assert response.status_code == 201
    body = response.json()
    assert body["id"]
    assert body["tournament_id"] == created["id"]
    assert body["name"] == "Open Singles"
    # Enum wire values keep the hyphenated prototype strings.
    assert body["format"] == "singles"
    assert body["draw_type"] == "rr-then-ko"
    assert body["max_players"] == 64
    # entry_fee is emitted as a JSON number, not a Decimal string.
    assert body["entry_fee"] == 45
    assert body["entered"] == 52
    assert body["slot"] == {"date": "2026-06-13", "start": "09:00", "end": "18:00"}
    assert body["match_settings"] == {"rated": True, "length_games": 5}
    assert body["predicates"] == [
        {"id": "pr-1", "field": "rating", "op": "<", "value": 1500}
    ]
    assert body["pools"] == [
        {
            "id": "p-os-1",
            "name": "Pool A",
            "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
            "table_ids": ["t1", "t2"],
        }
    ]


async def test_detail_lists_created_event(
    authed_client: tuple[AsyncClient, User],
):
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    event = (
        await client.post(
            f"/v1/tournaments/{created['id']}/events", json=_event_payload()
        )
    ).json()

    detail = (await client.get(f"/v1/tournaments/{created['id']}")).json()
    assert [e["id"] for e in detail["events"]] == [event["id"]]
    assert detail["events"][0]["draw_type"] == "rr-then-ko"


async def test_patch_event_by_creator_updates_jsonb(
    authed_client: tuple[AsyncClient, User],
):
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    event = (
        await client.post(
            f"/v1/tournaments/{created['id']}/events", json=_event_payload()
        )
    ).json()

    new_pools = [
        {
            "id": "p-new",
            "name": "Pool Z",
            "slot": {"date": "2026-06-14", "start": "10:00", "end": "14:00"},
            "table_ids": ["t3"],
        }
    ]
    new_predicates = [{"id": "pr-9", "field": "age", "op": "<", "value": 18}]
    response = await client.patch(
        f"/v1/tournaments/{created['id']}/events/{event['id']}",
        json={
            "draw_type": "single-elim",
            "pools": new_pools,
            "predicates": new_predicates,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["draw_type"] == "single-elim"
    assert body["pools"] == new_pools
    assert body["predicates"] == new_predicates
    # Untouched fields survive.
    assert body["name"] == "Open Singles"
    assert body["format"] == "singles"


async def test_patch_event_explicit_null_name_returns_422(
    authed_client: tuple[AsyncClient, User],
):
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    event = (
        await client.post(
            f"/v1/tournaments/{created['id']}/events", json=_event_payload()
        )
    ).json()
    response = await client.patch(
        f"/v1/tournaments/{created['id']}/events/{event['id']}",
        json={"name": None},
    )
    assert response.status_code == 422


async def test_patch_event_explicit_null_predicates_returns_422(
    authed_client: tuple[AsyncClient, User],
):
    # predicates/pools are NOT NULL JSONB columns — explicit null is a 422.
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    event = (
        await client.post(
            f"/v1/tournaments/{created['id']}/events", json=_event_payload()
        )
    ).json()
    response = await client.patch(
        f"/v1/tournaments/{created['id']}/events/{event['id']}",
        json={"predicates": None},
    )
    assert response.status_code == 422


async def test_patch_event_explicit_null_pools_returns_422(
    authed_client: tuple[AsyncClient, User],
):
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    event = (
        await client.post(
            f"/v1/tournaments/{created['id']}/events", json=_event_payload()
        )
    ).json()
    response = await client.patch(
        f"/v1/tournaments/{created['id']}/events/{event['id']}",
        json={"pools": None},
    )
    assert response.status_code == 422


async def test_patch_event_rejects_server_managed_entered(
    authed_client: tuple[AsyncClient, User],
):
    # ``entered`` is a server-managed registration count, not updatable via PATCH
    # — extra="forbid" rejects it with a 422.
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    event = (
        await client.post(
            f"/v1/tournaments/{created['id']}/events", json=_event_payload()
        )
    ).json()
    response = await client.patch(
        f"/v1/tournaments/{created['id']}/events/{event['id']}",
        json={"entered": 99},
    )
    assert response.status_code == 422


async def test_delete_event_by_creator_returns_204(
    authed_client: tuple[AsyncClient, User],
):
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    event = (
        await client.post(
            f"/v1/tournaments/{created['id']}/events", json=_event_payload()
        )
    ).json()

    response = await client.delete(
        f"/v1/tournaments/{created['id']}/events/{event['id']}"
    )
    assert response.status_code == 204

    detail = (await client.get(f"/v1/tournaments/{created['id']}")).json()
    assert detail["events"] == []


async def test_event_ops_on_missing_tournament_return_404(
    authed_client: tuple[AsyncClient, User],
):
    client, _ = authed_client
    missing = "00000000-0000-0000-0000-000000000000"
    assert (
        await client.post(f"/v1/tournaments/{missing}/events", json=_event_payload())
    ).status_code == 404
    assert (
        await client.patch(
            f"/v1/tournaments/{missing}/events/{missing}", json={"name": "x"}
        )
    ).status_code == 404
    assert (
        await client.delete(f"/v1/tournaments/{missing}/events/{missing}")
    ).status_code == 404


async def test_event_ops_on_missing_event_return_404(
    authed_client: tuple[AsyncClient, User],
):
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    missing = "00000000-0000-0000-0000-000000000000"
    assert (
        await client.patch(
            f"/v1/tournaments/{created['id']}/events/{missing}",
            json={"name": "x"},
        )
    ).status_code == 404
    assert (
        await client.delete(f"/v1/tournaments/{created['id']}/events/{missing}")
    ).status_code == 404


# ----- permission gate -----------------------------------------------------


async def test_permission_gate_blocks_user_without_permission(
    db_session: AsyncSession,
    authed_client: tuple[AsyncClient, User],
):
    """A user WITHOUT ``tournament.manage`` is 403 on every route, including the
    event routes. The ``authed_client`` fixture supplies a tournament + event
    owned by someone else so the parametrized routes have a real target (the
    gate runs before the 404/ownership checks)."""
    owner_client, _ = authed_client
    target = (await owner_client.post("/v1/tournaments", json=_create_payload())).json()
    target_event = (
        await owner_client.post(
            f"/v1/tournaments/{target['id']}/events", json=_event_payload()
        )
    ).json()

    async with make_client() as client:
        # A bare guest session — no tournament.manage granted.
        await start_session(client, db_session)

        assert (await client.get("/v1/tournaments")).status_code == 403
        assert (
            await client.post("/v1/tournaments", json=_create_payload())
        ).status_code == 403
        assert (await client.get(f"/v1/tournaments/{target['id']}")).status_code == 403
        assert (
            await client.patch(
                f"/v1/tournaments/{target['id']}", json={"name": "Hijack"}
            )
        ).status_code == 403
        assert (
            await client.delete(f"/v1/tournaments/{target['id']}")
        ).status_code == 403
        assert (
            await client.post(
                f"/v1/tournaments/{target['id']}/events", json=_event_payload()
            )
        ).status_code == 403
        assert (
            await client.patch(
                f"/v1/tournaments/{target['id']}/events/{target_event['id']}",
                json={"name": "Hijack"},
            )
        ).status_code == 403
        assert (
            await client.delete(
                f"/v1/tournaments/{target['id']}/events/{target_event['id']}"
            )
        ).status_code == 403


# ----- ownership (permitted non-creator) -----------------------------------


async def test_non_creator_with_permission_can_read_but_not_modify(
    db_session: AsyncSession,
    authed_client: tuple[AsyncClient, User],
):
    """A SECOND user who HAS ``tournament.manage`` but did not create the
    tournament: GET detail -> 200 with can_edit False; PATCH/DELETE and all
    event mutations -> 403."""
    owner_client, _ = authed_client
    target = (await owner_client.post("/v1/tournaments", json=_create_payload())).json()
    target_event = (
        await owner_client.post(
            f"/v1/tournaments/{target['id']}/events", json=_event_payload()
        )
    ).json()

    async with make_client() as other_client:
        other = await start_session(other_client, db_session)
        await _grant_tournament_manage(db_session, other)

        got = await other_client.get(f"/v1/tournaments/{target['id']}")
        assert got.status_code == 200
        assert got.json()["can_edit"] is False

        assert (
            await other_client.patch(
                f"/v1/tournaments/{target['id']}", json={"name": "Hijack"}
            )
        ).status_code == 403
        assert (
            await other_client.delete(f"/v1/tournaments/{target['id']}")
        ).status_code == 403
        assert (
            await other_client.post(
                f"/v1/tournaments/{target['id']}/events", json=_event_payload()
            )
        ).status_code == 403
        assert (
            await other_client.patch(
                f"/v1/tournaments/{target['id']}/events/{target_event['id']}",
                json={"name": "Hijack"},
            )
        ).status_code == 403
        assert (
            await other_client.delete(
                f"/v1/tournaments/{target['id']}/events/{target_event['id']}"
            )
        ).status_code == 403
