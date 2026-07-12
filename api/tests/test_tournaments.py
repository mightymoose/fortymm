"""Endpoint tests for the tournaments router.

Unlike test_rbac (which bypasses the authz gate via dependency_overrides),
these tests exercise the *real* permission gate: each client establishes a
genuine session via ``GET /v1/session`` and is granted ``tournament.view`` +
``tournament.create`` by inserting real Permission/Role/RolePermission/UserRole
rows. (Editing, deleting, and publishing are owner-only — no permission gates
them — so there is nothing extra to grant for those.) Mutating requests
carry the double-submit CSRF token via ``CSRF_EVENT_HOOKS`` (baked into both the
``api_client`` fixture and ``make_client``).
"""

import uuid
from collections.abc import AsyncIterator, Sequence
from typing import Any

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.models import (
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentStatus,
    User,
)
from app.tournaments import TOURNAMENT_CREATE, TOURNAMENT_VIEW, list_tournaments
from tests._helpers import (
    counted_statements,
    grant_permissions,
    make_client,
    make_user,
    start_session,
)


async def _grant_tournament_perms(
    db_session: AsyncSession,
    user: User,
    names: Sequence[str] = (TOURNAMENT_VIEW, TOURNAMENT_CREATE),
) -> None:
    """Grant ``names`` to ``user`` via real RBAC rows, defaulting to the pair the
    tournament read/create routes gate on."""
    await grant_permissions(db_session, user, names)


@pytest_asyncio.fixture
async def authed_client(
    api_client: AsyncClient, db_session: AsyncSession
) -> AsyncIterator[tuple[AsyncClient, User]]:
    """The primary ``api_client`` with a real session whose user holds
    ``tournament.view`` + ``tournament.create``."""
    user = await start_session(api_client, db_session)
    await _grant_tournament_perms(db_session, user)
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


async def test_create_is_born_draft_from_the_column_default(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
):
    """A tournament created through the normal route is ``draft`` — and it is the
    *column's* server default that says so, not a schema default: the create
    schema has no ``status`` field to default (ADR-0017)."""
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()

    assert created["status"] == "draft"
    # Read the row back too, not just the response: the response is serialized
    # from the refreshed ORM object, so this is what actually landed in the column.
    row = (
        await db_session.execute(
            select(Tournament).where(Tournament.id == uuid.UUID(created["id"]))
        )
    ).scalar_one()
    assert row.status is TournamentStatus.draft


async def test_create_with_a_status_is_422_and_creates_nothing(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
):
    """Creating a tournament that is born ``live`` (or born anything) is refused.

    ``status`` is not on the create schema, and the schema is ``extra="forbid"``,
    so the field is rejected at the boundary rather than obeyed — the lifecycle
    starts at ``draft`` and moves only across a guarded edge. It was accepted
    before #783: this request used to answer 201 with a ``published`` tournament.
    """
    client, _ = authed_client
    response = await client.post(
        "/v1/tournaments", json=_create_payload(status="published")
    )

    assert response.status_code == 422, response.text
    # Refused at the boundary means no row: a 422 that had already written one
    # would be a 422 in name only.
    count = (
        await db_session.execute(select(func.count()).select_from(Tournament))
    ).scalar_one()
    assert count == 0


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
            "start_date": "2026-08-01",
            "end_date": "2026-08-02",
            "address": new_address,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "Bay Area Major"
    assert body["start_date"] == "2026-08-01"
    assert body["end_date"] == "2026-08-02"
    assert body["address"] == new_address
    # Editing the tournament does not touch where it is in its lifecycle.
    assert body["status"] == "draft"


async def test_patch_explicit_null_name_returns_422(
    authed_client: tuple[AsyncClient, User],
):
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    response = await client.patch(
        f"/v1/tournaments/{created['id']}", json={"name": None}
    )
    assert response.status_code == 422


@pytest.mark.parametrize("value", ["live", "published", None], ids=str)
async def test_patch_with_a_status_is_422_and_leaves_the_status_unchanged(
    authed_client: tuple[AsyncClient, User],
    value: str | None,
):
    """``PATCH`` cannot move the lifecycle — with any value, including ``null``.

    ``status`` is not a field of the update schema at all (ADR-0017), so
    ``extra="forbid"`` refuses it: the transitions endpoint is the only door. It
    was an ordinary optional field before #783, and this same request answered 200
    with a ``live`` tournament — which is why the status is re-read afterwards
    rather than trusted to the 422: a handler that wrote the value and *then*
    failed would pass a status-code-only assertion.
    """
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()

    response = await client.patch(
        f"/v1/tournaments/{created['id']}", json={"status": value}
    )

    assert response.status_code == 422, response.text
    assert await _status_of(client, created["id"]) == "draft"


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
    # Nobody has entered a brand-new event: the derived count is 0 and the
    # entrants list is empty (an empty list, not a missing key).
    assert body["entered"] == 0
    assert body["entrants"] == []
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


# ----- entrants and the derived ``entered`` count ---------------------------


async def _enter(
    db_session: AsyncSession,
    event_id: str,
    user: User,
    *,
    status: TournamentEntryStatus = TournamentEntryStatus.entered,
    seed: int | None = None,
) -> TournamentEntry:
    """Persist an entry directly. The enter/withdraw *routes* land in #781/1c+1d;
    the read path can't wait for them, so it writes the rows itself."""
    entry = TournamentEntry(
        event_id=uuid.UUID(event_id), user_id=user.id, status=status, seed=seed
    )
    db_session.add(entry)
    await db_session.commit()
    return entry


async def test_tournament_events_has_no_entered_column(db_session: AsyncSession):
    """The registration count is derived, so there is no column to derive it from
    — and therefore no stored counter that can drift from the entries (ADR-0016).

    Read from the live database rather than the model: this is a claim about the
    schema, and the model attribute could be gone while the column lingered.
    """
    columns = set(
        (
            await db_session.execute(
                text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_name = 'tournament_events'"
                )
            )
        )
        .scalars()
        .all()
    )
    assert "entered" not in columns, columns
    # The query is real: the columns it *does* return are the ones we expect.
    assert {"id", "max_players", "entry_fee"} <= columns


async def test_detail_derives_entered_and_lists_only_active_entrants(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
):
    """Two active entrants and one withdrawn one: ``entered`` is 2, and the
    entrants list holds exactly the two active players. The withdrawn one appears
    in neither — she is not an entrant, and she is not counted."""
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    event = (
        await client.post(
            f"/v1/tournaments/{created['id']}/events", json=_event_payload()
        )
    ).json()

    ada = await make_user(db_session, "ada-entrant")
    bo = await make_user(db_session, "bo-entrant")
    cass = await make_user(db_session, "cass-withdrew")
    ada_entry = await _enter(db_session, event["id"], ada, seed=1)
    await _enter(db_session, event["id"], bo)
    await _enter(db_session, event["id"], cass, status=TournamentEntryStatus.withdrawn)

    detail = (await client.get(f"/v1/tournaments/{created['id']}")).json()
    (read_event,) = detail["events"]

    assert read_event["entered"] == 2
    entrants = {e["username"]: e for e in read_event["entrants"]}
    assert set(entrants) == {"ada-entrant", "bo-entrant"}
    assert entrants["ada-entrant"]["user_id"] == str(ada.id)
    assert entrants["ada-entrant"]["seed"] == 1
    assert entrants["bo-entrant"]["seed"] is None
    # Each entrant carries its ENTRY's id — the address a client withdraws
    # through — not just the player's.
    assert entrants["ada-entrant"]["id"] == str(ada_entry.id)
    # And the count is the list's length by construction — they cannot disagree.
    assert read_event["entered"] == len(read_event["entrants"])


async def test_list_derives_entered_and_lists_only_active_entrants(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
):
    """The same derivation on the list endpoint, which the tournaments-list card's
    entry total reads."""
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    event = (
        await client.post(
            f"/v1/tournaments/{created['id']}/events", json=_event_payload()
        )
    ).json()

    ada = await make_user(db_session, "ada-listed")
    cass = await make_user(db_session, "cass-listed-withdrew")
    await _enter(db_session, event["id"], ada)
    await _enter(db_session, event["id"], cass, status=TournamentEntryStatus.withdrawn)

    rows = (await client.get("/v1/tournaments")).json()
    listed = next(r for r in rows if r["id"] == created["id"])
    (read_event,) = listed["events"]

    assert read_event["entered"] == 1
    assert [e["username"] for e in read_event["entrants"]] == ["ada-listed"]


async def test_patch_event_answers_with_its_existing_entrants(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
):
    """Editing an event doesn't blank its entrants: the PATCH response carries the
    people who had already entered, with the count to match."""
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    event = (
        await client.post(
            f"/v1/tournaments/{created['id']}/events", json=_event_payload()
        )
    ).json()
    ada = await make_user(db_session, "ada-patched")
    await _enter(db_session, event["id"], ada)

    response = await client.patch(
        f"/v1/tournaments/{created['id']}/events/{event['id']}",
        json={"name": "Renamed Singles"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "Renamed Singles"
    assert body["entered"] == 1
    assert [e["username"] for e in body["entrants"]] == ["ada-patched"]


# The pin, measured (print the statements below to re-measure): the tournaments +
# usernames join, the events, and ONE batched load of every event's active
# entrants. Three, whatever the number of events.
EXPECTED_TOURNAMENT_LIST_STATEMENTS = 3


@pytest.mark.parametrize("event_count", [1, 4])
async def test_list_tournaments_statement_count_does_not_grow_with_events(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    engine: AsyncEngine,
    event_count: int,
):
    """The list endpoint returns every tournament with all of its events, so the
    entry counts and entrants MUST be gathered in one batched query — a
    ``count(*)`` per event is an N+1 (ADR-0015, ADR-0016).

    The two ``event_count`` cases are what makes this discriminating: a per-event
    loop emits one statement per event, so it would measure 4 at one event and 7 at
    four — failing the pin at four even if it slipped past at one. Each event
    carries a different number of entrants, so a batched loader that silently
    dropped the grouping would show up as wrong data, not just a low count.

    Counting is scoped to the handler rather than the HTTP request on purpose: an
    endpoint-level count would also sweep up session / auth statements that have
    nothing to do with the N+1. It runs on a fresh session — see
    ``counted_statements``.
    """
    client, user = authed_client
    user_id = user.id  # read outside the counted block; see below
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    for n in range(event_count):
        event = (
            await client.post(
                f"/v1/tournaments/{created['id']}/events",
                json=_event_payload(name=f"Event {n}"),
            )
        ).json()
        # n + 1 entrants on event n, so a broken grouping can't accidentally look
        # right, plus a withdrawn one that must never be counted.
        for i in range(n + 1):
            await _enter(
                db_session, event["id"], await make_user(db_session, f"player-{n}-{i}")
            )
        await _enter(
            db_session,
            event["id"],
            await make_user(db_session, f"gone-{n}"),
            status=TournamentEntryStatus.withdrawn,
        )

    async with counted_statements(engine) as (session, statements):
        # A transient ``User`` carrying only the id the handler reads: touching the
        # db_session-bound instance in here could emit a refresh SELECT on the same
        # engine and be counted as if the handler had issued it.
        listed = await list_tournaments(db=session, current_user=User(id=user_id))

    for n, statement in enumerate(statements, start=1):
        print(f"[{n}] {' '.join(statement.split())}")

    assert len(statements) == EXPECTED_TOURNAMENT_LIST_STATEMENTS, statements
    # And the block it counted really did the work: every event carries its own
    # entrants, and the withdrawn player is nowhere.
    (tournament,) = [t for t in listed if str(t.id) == created["id"]]
    assert len(tournament.events) == event_count
    assert [e.entered for e in tournament.events] == list(range(1, event_count + 1))
    assert all(
        len(e.entrants) == e.entered
        and not any(x.username.startswith("gone-") for x in e.entrants)
        for e in tournament.events
    )


# ----- permission gate -----------------------------------------------------


async def test_permission_gate_blocks_user_without_permission(
    db_session: AsyncSession,
    authed_client: tuple[AsyncClient, User],
):
    """A user with NO tournament permissions is 403 on every route, including the
    event routes. Reads/create are blocked by the ``tournament.view`` /
    ``tournament.create`` gates; the owner-only mutations are blocked by the
    ownership check (the caller has a session but didn't create the target). The
    ``authed_client`` fixture supplies a tournament + event owned by someone else
    so the routes have a real target."""
    owner_client, _ = authed_client
    target = (await owner_client.post("/v1/tournaments", json=_create_payload())).json()
    target_event = (
        await owner_client.post(
            f"/v1/tournaments/{target['id']}/events", json=_event_payload()
        )
    ).json()

    async with make_client() as client:
        # A bare guest session — no tournament permissions granted.
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


async def test_view_permission_alone_reads_but_cannot_create(
    db_session: AsyncSession,
    authed_client: tuple[AsyncClient, User],
):
    """``tournament.view`` is its own grant, separate from create: a viewer can
    list and read tournaments but POST /v1/tournaments is 403 without
    ``tournament.create``."""
    owner_client, _ = authed_client
    target = (await owner_client.post("/v1/tournaments", json=_create_payload())).json()

    async with make_client() as viewer_client:
        viewer = await start_session(viewer_client, db_session)
        await _grant_tournament_perms(db_session, viewer, names=(TOURNAMENT_VIEW,))

        assert (await viewer_client.get("/v1/tournaments")).status_code == 200
        assert (
            await viewer_client.get(f"/v1/tournaments/{target['id']}")
        ).status_code == 200
        assert (
            await viewer_client.post("/v1/tournaments", json=_create_payload())
        ).status_code == 403


# ----- ownership (permitted non-creator) -----------------------------------


async def test_non_creator_with_permission_can_read_but_not_modify(
    db_session: AsyncSession,
    authed_client: tuple[AsyncClient, User],
):
    """A SECOND user who HAS view+create but did not create the tournament:
    GET detail -> 200 with can_edit False; PATCH/DELETE and all event mutations
    -> 403 (owner-only)."""
    owner_client, _ = authed_client
    target = (await owner_client.post("/v1/tournaments", json=_create_payload())).json()
    target_event = (
        await owner_client.post(
            f"/v1/tournaments/{target['id']}/events", json=_event_payload()
        )
    ).json()

    async with make_client() as other_client:
        other = await start_session(other_client, db_session)
        await _grant_tournament_perms(db_session, other)

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


# ----- lifecycle transitions ------------------------------------------------
#
# The three legal edges, written out here rather than imported from
# ``app.tournaments.LEGAL_TRANSITIONS``: a test that reads its expectations out of
# the table under test would agree with that table however wrong it got. These are
# the edges ADR-0017 decided on, stated independently.
_LEGAL_EDGES = {
    (TournamentStatus.draft, TournamentStatus.published),
    (TournamentStatus.published, TournamentStatus.live),
    (TournamentStatus.live, TournamentStatus.archived),
}
# Every ordered pair of the four statuses is either legal or a conflict, so the
# two lists below are built as a partition of all 4x4 = 16 — including the four
# self-transitions, which ADR-0017 makes conflicts rather than idempotent no-ops.
# Deriving the illegal thirteen by subtraction (rather than typing them out) is
# what guarantees the matrix has no hole: a new status added to the enum lands in
# one list or the other automatically.
_ALL_EDGES = [(a, b) for a in TournamentStatus for b in TournamentStatus]
_ILLEGAL_EDGES = [edge for edge in _ALL_EDGES if edge not in _LEGAL_EDGES]


def _edge_params(
    edges: Sequence[tuple[TournamentStatus, TournamentStatus]],
) -> list[Any]:
    """``(start, target)`` cases named ``draft_to_published``, so a failure in the
    matrix names the edge that broke rather than an index."""
    return [
        pytest.param(start, target, id=f"{start.value}_to_{target.value}")
        for start, target in edges
    ]


async def _set_status(
    db_session: AsyncSession, tournament_id: str, status: TournamentStatus
) -> None:
    """Put a tournament into ``status`` by writing the column directly.

    A test cannot ask the API for a ``live`` starting point: the transition route
    is the only thing that moves a tournament, and reaching ``live`` through it
    means walking the very edges under test — so a bug that wrongly *allowed* an
    edge would quietly build its own precondition. Writing the row states the
    precondition instead of assuming it. (It also survives #783/1b, which removes
    ``status`` from the create schema.)
    """
    tournament = (
        await db_session.execute(
            select(Tournament).where(Tournament.id == uuid.UUID(tournament_id))
        )
    ).scalar_one()
    tournament.status = status
    await db_session.commit()


async def _status_of(client: AsyncClient, tournament_id: str) -> str:
    """Re-read the persisted status through the API.

    Deliberately not through the ``db_session`` fixture: the route commits on its
    own session, so the seeded row sitting in ``db_session``'s identity map would
    hand back a stale value and a genuinely-persisted move would read as a failure.
    """
    response = await client.get(f"/v1/tournaments/{tournament_id}")
    assert response.status_code == 200
    status_value: str = response.json()["status"]
    return status_value


@pytest.mark.parametrize(
    ("start", "target"),
    _edge_params([edge for edge in _ALL_EDGES if edge in _LEGAL_EDGES]),
)
async def test_transition_legal_edge_moves_the_tournament_and_persists(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    start: TournamentStatus,
    target: TournamentStatus,
):
    """Each of the three forward edges is accepted, answers with the moved
    tournament, and the move is still there on the next read."""
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    await _set_status(db_session, created["id"], start)

    response = await client.post(
        f"/v1/tournaments/{created['id']}/transitions", json={"to": target.value}
    )

    assert response.status_code == 201, response.text
    assert response.json()["status"] == target.value
    assert await _status_of(client, created["id"]) == target.value


@pytest.mark.parametrize(("start", "target"), _edge_params(_ILLEGAL_EDGES))
async def test_transition_illegal_edge_conflicts_and_leaves_status_unchanged(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    start: TournamentStatus,
    target: TournamentStatus,
):
    """The other thirteen ordered pairs are all refused — backwards edges, skipped
    stages, anything out of the terminal ``archived``, and every self-transition —
    and the tournament is left exactly where it was."""
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    await _set_status(db_session, created["id"], start)

    response = await client.post(
        f"/v1/tournaments/{created['id']}/transitions", json={"to": target.value}
    )

    assert response.status_code == 409, response.text
    # Human-readable, and about the tournament rather than the schema: it names
    # where the tournament is and where the caller tried to send it.
    detail = response.json()["detail"]
    assert start.value in detail and target.value in detail
    assert await _status_of(client, created["id"]) == start.value


async def test_transition_by_non_owner_is_403_before_the_edge_is_judged(
    db_session: AsyncSession,
    authed_client: tuple[AsyncClient, User],
):
    """A permitted non-creator cannot move someone else's tournament.

    The requested edge is an *illegal* one (a self-transition), which is what makes
    this a test of ordering and not just of the code: if the handler judged the
    edge before ownership it would answer 409, so 403 proves the ownership check
    short-circuits first — a stranger learns nothing about what state a tournament
    they cannot touch is in.
    """
    owner_client, _ = authed_client
    target = (await owner_client.post("/v1/tournaments", json=_create_payload())).json()

    async with make_client() as other_client:
        other = await start_session(other_client, db_session)
        await _grant_tournament_perms(db_session, other)

        response = await other_client.post(
            f"/v1/tournaments/{target['id']}/transitions", json={"to": "draft"}
        )

        assert response.status_code == 403
        # And a *legal* edge is refused just the same — it isn't their tournament.
        assert (
            await other_client.post(
                f"/v1/tournaments/{target['id']}/transitions", json={"to": "published"}
            )
        ).status_code == 403
        assert await _status_of(owner_client, target["id"]) == "draft"


async def test_transition_on_missing_tournament_returns_404(
    authed_client: tuple[AsyncClient, User],
):
    """A tournament that doesn't exist is a 404 — the row is loaded before either
    ownership or the edge gets a say."""
    client, _ = authed_client
    response = await client.post(
        "/v1/tournaments/00000000-0000-0000-0000-000000000000/transitions",
        json={"to": "published"},
    )
    assert response.status_code == 404


@pytest.mark.parametrize(
    "body",
    [
        pytest.param({"to": "cancelled"}, id="unknown_status"),
        pytest.param({"to": None}, id="null_status"),
        pytest.param({}, id="missing_to"),
        pytest.param({"to": "published", "from": "draft"}, id="extra_field"),
    ],
)
async def test_transition_with_an_invalid_body_returns_422(
    authed_client: tuple[AsyncClient, User],
    body: dict[str, Any],
):
    """``to`` is a ``TournamentStatus``, so a status outside the enum never reaches
    the edge table — it is a 422 at the boundary. ``extra="forbid"`` rejects a
    ``from`` as well: the tournament's current status is the server's to read, not
    the client's to assert."""
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()

    response = await client.post(
        f"/v1/tournaments/{created['id']}/transitions", json=body
    )

    assert response.status_code == 422
    assert await _status_of(client, created["id"]) == "draft"
