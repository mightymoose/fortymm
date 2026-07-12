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

import asyncio
import json
import uuid
from collections.abc import AsyncIterator, Sequence
from decimal import Decimal
from typing import Any

import pytest
import pytest_asyncio
from fastapi import HTTPException
from httpx import AsyncClient
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.leagues import seed_user_league_rating
from app.models import (
    League,
    LeagueVisibility,
    RatingStrategy,
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentStatus,
    User,
    UserLeagueRating,
)
from app.schemas.tournament import (
    EventEntryFull,
    EventEntryRatingIneligible,
    TournamentTransitionCreate,
)
from app.tournament_entry_refusals import EntryRefusal
from app.tournaments import (
    TOURNAMENT_CREATE,
    TOURNAMENT_VIEW,
    _get_tournament_for_update_or_404,
    _get_tournament_or_404,
    create_tournament_transition,
    get_tournament,
    list_tournaments,
)
from tests._helpers import (
    counted_statements,
    grant_permissions,
    make_client,
    make_user,
    rate_player,
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


async def test_create_event_persists_the_rating_predicate(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
):
    """``rating`` is the one fact we hold about a player (ADR-0783), so a rating
    rule is authorable — and it lands in the JSONB column, not just in the echo."""
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()

    response = await client.post(
        f"/v1/tournaments/{created['id']}/events", json=_event_payload()
    )
    assert response.status_code == 201, response.text

    row = (
        await db_session.execute(
            select(TournamentEvent).where(
                TournamentEvent.id == uuid.UUID(response.json()["id"])
            )
        )
    ).scalar_one()
    assert row.predicates == [
        {"id": "pr-1", "field": "rating", "op": "<", "value": 1500}
    ]


@pytest.mark.parametrize(
    ("field", "value"),
    [("age", 18), ("gender", "female"), ("club", True)],
)
async def test_create_event_with_an_unevaluatable_predicate_is_422_and_writes_nothing(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    field: str,
    value: object,
) -> None:
    """A rule naming a player attribute we do not hold is refused at the boundary.

    ``age``/``gender``/``club`` are not columns anywhere — there is no date of
    birth, no gender and no club on a player — so a rule over one could never be
    evaluated. Before #783 the API stored it happily and the event page told
    players "Players must satisfy every rule to enter", which was a lie. The field
    is off the ``Literal`` now, so ``extra="forbid"`` + the enum check answer 422
    (ADR-0783) and *no event row is written*.
    """
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()

    response = await client.post(
        f"/v1/tournaments/{created['id']}/events",
        json=_event_payload(
            predicates=[{"id": "pr-x", "field": field, "op": "<", "value": value}]
        ),
    )

    assert response.status_code == 422, response.text
    # A 422 that had already written the event would be a 422 in name only.
    count = (
        await db_session.execute(select(func.count()).select_from(TournamentEvent))
    ).scalar_one()
    assert count == 0


@pytest.mark.parametrize(
    ("field", "value"),
    [("age", 18), ("gender", "female"), ("club", True)],
)
async def test_patch_event_with_an_unevaluatable_predicate_is_422_and_stores_nothing(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    field: str,
    value: object,
) -> None:
    """The patch path refuses the removed fields too.

    Create is only half the boundary: an event born with an honest rating rule and
    then *patched* into an age rule would be exactly the state #783 exists to make
    unrepresentable. The event's stored predicates are re-read to prove the rule
    never landed, rather than trusting the status code.
    """
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    event = (
        await client.post(
            f"/v1/tournaments/{created['id']}/events", json=_event_payload()
        )
    ).json()

    response = await client.patch(
        f"/v1/tournaments/{created['id']}/events/{event['id']}",
        json={
            "predicates": [{"id": "pr-x", "field": field, "op": "<", "value": value}]
        },
    )

    assert response.status_code == 422, response.text
    row = (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == uuid.UUID(event["id"]))
        )
    ).scalar_one()
    # Still the rating rule it was created with: the age/gender/club rule is not in
    # the column under any id.
    assert row.predicates == [
        {"id": "pr-1", "field": "rating", "op": "<", "value": 1500}
    ]


@pytest.mark.parametrize(
    ("op", "value", "why"),
    [
        ("~=", 1500, "an operator that does not exist"),
        ("<>", 1500, "an operator from another language"),
        ("between", 1500, "`between` given a single number instead of a pair"),
        ("<", [1200, 1500], "a comparison given a [min, max] pair"),
        ("between", [1200], "a `between` pair with one bound"),
        ("between", [1000, 1200, 1500], "a `between` pair with three"),
        ("<", "1500", "a rating rule compared against a string"),
        ("<", True, "a rating rule compared against a boolean"),
    ],
)
async def test_create_event_with_an_undecidable_rule_is_422_and_writes_nothing(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    op: str,
    value: object,
    why: str,
) -> None:
    """A rule the evaluator could not decide is refused at the **boundary**, not
    handled at evaluation time (ADR-0783).

    ``op`` is a closed ``Literal`` of the seven operators and ``value`` is a number or
    a two-bound pair, tied to the operator that takes it. So an unknown operator, a
    ``between`` handed a single number, a comparison handed a pair, and a pair that is
    not exactly two long are all 422s — and the evaluator is a **total** function of
    what can actually reach it, rather than a function with a "what does ``~=`` mean?"
    branch in it that has to guess. Guessing has exactly two outcomes, and both are
    wrong: silently admitting a player the rule meant to bar, or silently barring one
    it meant to admit.

    The ``str``/``bool`` cases are the vestige of the removed fields (a gender was a
    string, a club a bare boolean). A rating is a number; nothing else is a rating.
    """
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()

    response = await client.post(
        f"/v1/tournaments/{created['id']}/events",
        json=_event_payload(
            predicates=[{"id": "pr-x", "field": "rating", "op": op, "value": value}]
        ),
    )

    assert response.status_code == 422, f"{why}: {response.text}"
    count = (
        await db_session.execute(select(func.count()).select_from(TournamentEvent))
    ).scalar_one()
    assert count == 0, why


async def test_a_rule_the_organizer_has_not_finished_writing_is_storable(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """A rule with **no value yet** is not an undecidable rule — it is an unfinished
    one, and an event must be saveable mid-edit.

    It is stored as-is and constrains nobody at evaluation time (see
    ``tests/test_tournament_eligibility.py``): refusing to *store* it would break the
    editor, and refusing every *player* on the strength of it would silently close an
    event whose director was interrupted.
    """
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()

    response = await client.post(
        f"/v1/tournaments/{created['id']}/events",
        json=_event_payload(
            predicates=[
                {"id": "pr-x", "field": "rating", "op": "<", "value": None},
                {
                    "id": "pr-y",
                    "field": "rating",
                    "op": "between",
                    "value": [1200, None],
                },
            ]
        ),
    )

    assert response.status_code == 201, response.text
    row = (
        await db_session.execute(
            select(TournamentEvent).where(
                TournamentEvent.id == uuid.UUID(response.json()["id"])
            )
        )
    ).scalar_one()
    assert row.predicates == [
        {"id": "pr-x", "field": "rating", "op": "<", "value": None},
        {"id": "pr-y", "field": "rating", "op": "between", "value": [1200, None]},
    ]


async def test_patch_event_with_an_undecidable_rule_is_422_and_stores_nothing(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """The patch path closes the same domain: an event born with an honest rating rule
    cannot be *patched* into one carrying an operator nobody can evaluate."""
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    event = (
        await client.post(
            f"/v1/tournaments/{created['id']}/events", json=_event_payload()
        )
    ).json()

    response = await client.patch(
        f"/v1/tournaments/{created['id']}/events/{event['id']}",
        json={
            "predicates": [{"id": "pr-x", "field": "rating", "op": "~=", "value": 1500}]
        },
    )

    assert response.status_code == 422, response.text
    row = (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == uuid.UUID(event["id"]))
        )
    ).scalar_one()
    assert row.predicates == [
        {"id": "pr-1", "field": "rating", "op": "<", "value": 1500}
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
    new_predicates = [{"id": "pr-9", "field": "rating", "op": ">=", "value": 1800}]
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


# ----- the column is a constraint too (#783 QA, round three) ----------------
#
# An event's two numbers are bounded by their COLUMNS whether the schema says so or
# not, and for a while only the columns said so: ``max_players`` was ``int, gt=0``
# over an ``Integer``, ``entry_fee`` was ``float, ge=0`` over a ``Numeric(8, 2)``.
# QA typed ``9999999999`` into the player limit; it satisfied every rule Pydantic
# stated, sailed through the boundary, and blew up in the driver — Postgres refused
# the out-of-range value and the API answered **500**. A 500 on ordinary user input
# is a server fault we were choosing to have.
#
# Every case below is therefore asserted twice: the status code, *and* the row. A 422
# is only a boundary if nothing was written; a 500 is not one at all.

PLAYER_LIMITS_THE_COLUMN_CANNOT_HOLD = [
    pytest.param(9_999_999_999, id="the-number-qa-typed"),
    pytest.param(2**31, id="one-past-the-Integer-column"),
    pytest.param(513, id="one-past-the-agreed-512"),
]

FEES_THE_COLUMN_CANNOT_HOLD = [
    pytest.param(9_999_999, id="a-seventh-digit-past-Numeric-8-2s-precision"),
    pytest.param(1_000_000, id="one-dollar-past-the-largest-storable-fee"),
    # Under a million, and still unstorable: it rounds *up* to 1000000.00, which
    # overflows the precision. This is the case that makes the bound `le=999_999.99`
    # (the largest storable fee, exactly) rather than a `< 1_000_000` that looks
    # equivalent and would have let this one through to the driver.
    pytest.param(999_999.999, id="a-fee-under-a-million-that-rounds-UP-into-overflow"),
    # Storable, and stored WRONG: Postgres does not refuse a third decimal, it rounds
    # it away. Measured against the old schema: 201, and the column held 45.01 — a
    # cent the organizer never typed, on a price.
    pytest.param(45.005, id="a-third-decimal-place-the-column-would-silently-round"),
]


@pytest.mark.parametrize("max_players", PLAYER_LIMITS_THE_COLUMN_CANNOT_HOLD)
async def test_create_event_with_an_unstorable_player_limit_is_422_and_writes_nothing(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    max_players: int,
) -> None:
    """A player limit the ``Integer`` column cannot hold is refused at the boundary.

    ``9999999999`` is the number that produced the 500. It is a 422 now, and 512 is
    the ceiling — the same number the web client's form enforces, so the two layers
    refuse the same events for the same reason rather than one crashing on what the
    other allowed.
    """
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()

    response = await client.post(
        f"/v1/tournaments/{created['id']}/events",
        json=_event_payload(max_players=max_players),
    )

    assert response.status_code == 422, response.text
    count = (
        await db_session.execute(select(func.count()).select_from(TournamentEvent))
    ).scalar_one()
    assert count == 0


@pytest.mark.parametrize("max_players", PLAYER_LIMITS_THE_COLUMN_CANNOT_HOLD)
async def test_patch_event_with_an_unstorable_player_limit_is_422_and_stores_nothing(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    max_players: int,
) -> None:
    """The patch path holds the same bound — otherwise it *is* the hole.

    An event born with a sane limit and then edited to ``9999999999`` reaches exactly
    the same DataError from exactly the same user input; a bound that only create
    keeps is a bound the API does not have. The stored limit is re-read rather than
    the status code trusted: a handler that wrote the value and only then failed
    would answer 422 and still be broken.
    """
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    event = (
        await client.post(
            f"/v1/tournaments/{created['id']}/events", json=_event_payload()
        )
    ).json()

    response = await client.patch(
        f"/v1/tournaments/{created['id']}/events/{event['id']}",
        json={"max_players": max_players},
    )

    assert response.status_code == 422, response.text
    row = (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == uuid.UUID(event["id"]))
        )
    ).scalar_one()
    assert row.max_players == 64


@pytest.mark.parametrize("entry_fee", FEES_THE_COLUMN_CANNOT_HOLD)
async def test_create_event_with_an_unstorable_entry_fee_is_422_and_writes_nothing(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    entry_fee: float,
) -> None:
    """A fee the ``Numeric(8, 2)`` column cannot hold is refused at the boundary.

    Two ways it cannot hold one, and both are here: **magnitude** (a seventh digit
    overflows the precision — the 500) and **scale** (a third decimal place, which
    Postgres does not refuse but silently *rounds away*). The rounding is refused too:
    a price is exact, and a boundary that quietly stores a number the organizer did
    not type is the same fault speaking softly. The two meet at ``999_999.999``, which
    is under a million *and* rounds up through the precision — which is why the bound
    is the largest storable fee itself, not a round number just above it.
    """
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()

    response = await client.post(
        f"/v1/tournaments/{created['id']}/events",
        json=_event_payload(entry_fee=entry_fee),
    )

    assert response.status_code == 422, response.text
    count = (
        await db_session.execute(select(func.count()).select_from(TournamentEvent))
    ).scalar_one()
    assert count == 0


@pytest.mark.parametrize("entry_fee", FEES_THE_COLUMN_CANNOT_HOLD)
async def test_patch_event_with_an_unstorable_entry_fee_is_422_and_stores_nothing(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    entry_fee: float,
) -> None:
    """The fee's bounds are the *same* bounds on the patch path — one alias, two
    schemas — so an event cannot be edited into a fee it could not have been created
    with. The stored fee is still the one it was created with."""
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    event = (
        await client.post(
            f"/v1/tournaments/{created['id']}/events", json=_event_payload()
        )
    ).json()

    response = await client.patch(
        f"/v1/tournaments/{created['id']}/events/{event['id']}",
        json={"entry_fee": entry_fee},
    )

    assert response.status_code == 422, response.text
    row = (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == uuid.UUID(event["id"]))
        )
    ).scalar_one()
    assert Decimal(str(row.entry_fee)) == Decimal("45.00")


@pytest.mark.parametrize(
    "entry_fee",
    [
        pytest.param(float("inf"), id="Infinity"),
        pytest.param(float("-inf"), id="-Infinity"),
        pytest.param(float("nan"), id="NaN"),
    ],
)
async def test_create_event_with_a_non_finite_entry_fee_is_422(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    entry_fee: float,
) -> None:
    """``Infinity`` is not a fee — and it is on the wire whether JSON admits it or not.

    Python's ``json.loads``, which Starlette parses the request body with, reads the
    bare tokens ``Infinity`` and ``NaN`` even though the JSON grammar has no such
    literals. A browser cannot author them (``JSON.stringify`` emits ``null``), and
    neither can httpx — which is why the body here is **hand-written**, exactly as curl
    or a native client could write it. An infinite fee passes ``ge=0``, so without
    ``allow_inf_nan=False`` it reaches a column that cannot hold it.

    This case also found the 422 handler's own bug: the refusal echoes the offending
    ``input`` back, and ``inf`` cannot be serialized by ``json.dumps(allow_nan=False)``
    — so the 422 was itself dying as a 500 (see ``validation_error_handler``,
    ``app/main.py``). Both halves are proved here: a refusal that cannot be *delivered*
    is not a refusal.
    """
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()

    response = await client.post(
        f"/v1/tournaments/{created['id']}/events",
        content=json.dumps(_event_payload(entry_fee=entry_fee)).encode(),
        headers={"content-type": "application/json"},
    )

    assert response.status_code == 422, response.text
    count = (
        await db_session.execute(select(func.count()).select_from(TournamentEvent))
    ).scalar_one()
    assert count == 0


async def test_create_event_at_the_very_edge_of_what_the_columns_hold_is_stored(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """The bounds are inclusive, and the values they admit really do land.

    The 422s above prove nothing on their own — a schema of ``le=0`` would pass every
    one of them and refuse every real event. So the extremes the columns *can* hold —
    a 512-player draw and a fee of 999,999.99 — are created and read back out of the
    database, which is the half of the boundary that says it is a bound and not a
    wall.
    """
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()

    response = await client.post(
        f"/v1/tournaments/{created['id']}/events",
        json=_event_payload(max_players=512, entry_fee=999_999.99),
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["max_players"] == 512
    assert body["entry_fee"] == 999_999.99
    row = (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == uuid.UUID(body["id"]))
        )
    ).scalar_one()
    assert row.max_players == 512
    assert Decimal(str(row.entry_fee)) == Decimal("999999.99")


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
# usernames join, the events, ONE batched load of every event's active entrants, and
# ONE batched load of the caller's rating on every league those tournaments run on
# (which each event's ``entry_state`` is judged against, ADR-0783). Four, whatever the
# number of tournaments and events.
EXPECTED_TOURNAMENT_LIST_STATEMENTS = 4


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
    loop emits one statement per event, so it would measure 5 at one event and 8 at
    four — failing the pin at four even if it slipped past at one. Each event
    carries a different number of entrants, so a batched loader that silently
    dropped the grouping would show up as wrong data, not just a low count.

    It pins the caller's RATING lookup too, which is the newest way to reintroduce the
    N+1 this test exists to prevent: every event's ``entry_state`` is judged against
    the caller's rating on the tournament's ladder (ADR-0783), and a rating fetched
    inside the per-event loop reads the same number once per event.

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
# A list, in lifecycle order, so it can be parametrized over directly: a set would
# hand pytest its three cases in whatever order the enum members happened to hash in
# that process.
_LEGAL_EDGES = [
    (TournamentStatus.draft, TournamentStatus.published),
    (TournamentStatus.published, TournamentStatus.live),
    (TournamentStatus.live, TournamentStatus.archived),
]
# Every ordered pair of the four statuses is either legal or a conflict, so the
# two lists below are built as a partition of all 4x4 = 16 — including the four
# self-transitions, which ADR-0017 makes conflicts rather than idempotent no-ops.
# Deriving the illegal thirteen by subtraction (rather than typing them out) is
# what guarantees the matrix has no hole: a new status added to the enum lands in
# one list or the other automatically.
_ALL_EDGES = [(a, b) for a in TournamentStatus for b in TournamentStatus]
_ILLEGAL_EDGES = [edge for edge in _ALL_EDGES if edge not in _LEGAL_EDGES]
# The thirteen refusals split into two shapes of sentence, so they are split into
# two lists here. Same partition-by-subtraction discipline: a self-transition is
# one whose ends are equal, and everything else is what's left.
_SELF_EDGES = [edge for edge in _ILLEGAL_EDGES if edge[0] == edge[1]]
_NON_SELF_ILLEGAL_EDGES = [edge for edge in _ILLEGAL_EDGES if edge[0] != edge[1]]


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


@pytest.mark.parametrize(("start", "target"), _edge_params(_LEGAL_EDGES))
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
    assert await _status_of(client, created["id"]) == start.value
    # What the refusal *says* is pinned by the two copy tests below, one per shape
    # of sentence. Asserting here merely that the detail mentions both ends would
    # be vacuous for the four self-transitions, where both ends are the same word.


@pytest.mark.parametrize(("start", "target"), _edge_params(_SELF_EDGES))
async def test_self_transition_says_the_tournament_is_already_in_that_status(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    start: TournamentStatus,
    target: TournamentStatus,
):
    """Re-asserting the status a tournament already holds is refused with the fact
    the caller is missing — that somebody already did it — not with a tautology.

    This is the refusal players actually meet: a second tab clicking "Start
    tournament" on a tournament that has since gone live sends ``live → live``.
    "This tournament is live; it cannot be moved to live" is true, unhelpful, and
    reads as nonsense under the toast title "Couldn't start the tournament".
    """
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    await _set_status(db_session, created["id"], start)

    response = await client.post(
        f"/v1/tournaments/{created['id']}/transitions", json={"to": target.value}
    )

    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail == f"This tournament is already {start.value}."
    # The tautological shape is gone, not merely reworded around.
    assert "cannot be moved" not in detail


@pytest.mark.parametrize(("start", "target"), _edge_params(_NON_SELF_ILLEGAL_EDGES))
async def test_non_self_illegal_transition_names_both_ends_of_the_edge(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    start: TournamentStatus,
    target: TournamentStatus,
):
    """The other nine refusals — backwards edges, skipped stages, anything out of
    the terminal ``archived`` — keep the two-ended sentence.

    A caller asking for a genuinely illegal jump needs both ends named: the target
    alone doesn't say why it was refused, because the same target is legal from a
    different status.
    """
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    await _set_status(db_session, created["id"], start)

    response = await client.post(
        f"/v1/tournaments/{created['id']}/transitions", json={"to": target.value}
    )

    assert response.status_code == 409, response.text
    assert response.json()["detail"] == (
        f"This tournament is {start.value}; it cannot be moved to {target.value}."
    )


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
    # A 422 alone would pass against a handler that wrote the status and only then
    # validated. Refusing at the boundary has to mean nothing moved.
    assert await _status_of(client, created["id"]) == "draft"


# ----- the row lock behind the lifecycle -------------------------------------
#
# A tournament's status is read by one statement and overwritten by another, and
# Postgres runs READ COMMITTED — so without a lock the two sit in different
# instants and every "the status decides this" rule has a window under it. The
# tests below pin the lock two ways: that it is *asked for* (and only on the
# writing paths), and that it *works* (two real sessions, one genuinely blocking
# on the other).


async def test_only_the_mutating_loader_takes_the_row_lock(
    db_session: AsyncSession,
    engine: AsyncEngine,
    authed_client: tuple[AsyncClient, User],
):
    """``_get_tournament_for_update_or_404`` emits ``SELECT … FOR UPDATE``;
    ``_get_tournament_or_404`` — the loader the read routes use — does not.

    Both halves are load-bearing. A locking loader that quietly stopped locking
    would reopen the entry-after-go-live race in silence; and a lock added to the
    *read* loader would make every page view queue behind (and hold up) writers,
    for a reader that has nothing to serialize against.
    """
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    tournament_id = uuid.UUID(created["id"])

    async with counted_statements(engine) as (session, statements):
        await _get_tournament_for_update_or_404(session, tournament_id)
    assert any("FOR UPDATE" in s for s in statements), statements

    async with counted_statements(engine) as (session, statements):
        await _get_tournament_or_404(session, tournament_id)
    assert not any("FOR UPDATE" in s for s in statements), statements


async def test_two_identical_transitions_racing_leave_exactly_one_winner(
    db_session: AsyncSession,
    engine: AsyncEngine,
    authed_client: tuple[AsyncClient, User],
):
    """Two identical ``draft → published`` requests fired at once: one 201, one 409.

    ADR-0017 makes re-asserting a status a *conflict*, not an idempotent no-op —
    "the only caller that sends it is a stale one". Unlocked, that guarantee held
    only when nobody was in a hurry: both requests would read ``draft``, both find
    the edge legal, and both answer 201, so a client could be told it published a
    tournament somebody else had already published. The row lock serializes them —
    the loser blocks, re-reads the status the winner *committed*, and gets the 409
    it is owed.

    Driven on two separate sessions (the handler called directly, as
    ``test_concurrent_accept_and_counter_serialize`` does for matches): the shared
    ``db_session`` override runs both requests on one connection, where a lock
    cannot block and the race cannot appear.
    """
    client, owner = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    tournament_id = uuid.UUID(created["id"])
    owner_id = owner.id
    make_session = async_sessionmaker(engine, expire_on_commit=False)

    async def publish() -> int | str:
        async with make_session() as session:
            actor = (
                await session.execute(select(User).where(User.id == owner_id))
            ).scalar_one()
            try:
                moved = await create_tournament_transition(
                    tournament_id,
                    TournamentTransitionCreate(to=TournamentStatus.published),
                    session,
                    actor,
                )
                return moved.status.value
            except HTTPException as exc:
                return exc.status_code

    outcomes = await asyncio.gather(publish(), publish())

    assert sorted(outcomes, key=str) == [409, "published"], outcomes
    async with make_session() as verify:
        final = (
            await verify.execute(
                select(Tournament).where(Tournament.id == tournament_id)
            )
        ).scalar_one()
        assert final.status is TournamentStatus.published


# ----- the league a tournament is judged on (ADR-0783) ----------------------
#
# A tournament's ``league_id`` is the rating ladder its events' eligibility rules
# are decided on. It is NOT NULL, it is resolved at create (an omitted league is
# the default one), and it is settled the moment the tournament leaves ``draft``.


@pytest_asyncio.fixture
async def other_league(
    db_session: AsyncSession, rating_strategies: dict[str, RatingStrategy]
) -> League:
    """A second league, deliberately NOT the default one.

    The whole point of ``league_id`` is that a tournament can name a ladder other
    than the fallback — a test with only the default league in the database could
    not tell "carries the league the caller named" apart from "carries the default,
    always", because the two ids would be the same id.
    """
    league = League(
        name="Bay Area Ladder",
        description="A second ladder. Not the default.",
        visibility=LeagueVisibility.public,
        is_default=False,
        rating_strategy_id=rating_strategies["glicko2"].id,
    )
    db_session.add(league)
    await db_session.commit()
    return league


async def _persisted_league_id(db_session: AsyncSession, tournament_id: str) -> str:
    """The league id on the ROW, not in a response body — so a handler that
    answered with the league it *meant* to write, without writing it, is caught."""
    row = (
        await db_session.execute(
            select(Tournament).where(Tournament.id == uuid.UUID(tournament_id))
        )
    ).scalar_one()
    return str(row.league_id)


async def test_create_without_a_league_runs_on_the_default_league(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    default_league: League,
    other_league: League,
):
    """``league_id`` is optional on the way in and NOT NULL in the database: a
    caller who names no ladder gets the **default** one (CONTEXT.md, "Default
    league") — resolved through the STRICT ``resolve_league``, which falls back
    to the default only when no league is *named*. It deliberately is not the
    degrading ``resolve_league_or_default``: that one answers an id naming no
    league with the default ladder, which would judge entrants on a ladder the
    director never chose. The non-default ``other_league`` is seeded here
    precisely so "the default" cannot be satisfied by "the only one".
    """
    client, _ = authed_client
    payload = _create_payload()
    assert "league_id" not in payload

    response = await client.post("/v1/tournaments", json=payload)

    assert response.status_code == 201, response.text
    created = response.json()
    assert created["league_id"] == str(default_league.id)
    assert created["league_id"] != str(other_league.id)
    assert await _persisted_league_id(db_session, created["id"]) == str(
        default_league.id
    )


async def test_create_naming_a_league_runs_on_that_league(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    default_league: League,
    other_league: League,
):
    """A caller who names a ladder gets *that* ladder — not the default one it
    would have fallen back to."""
    client, _ = authed_client

    response = await client.post(
        "/v1/tournaments", json=_create_payload(league_id=str(other_league.id))
    )

    assert response.status_code == 201, response.text
    created = response.json()
    assert created["league_id"] == str(other_league.id)
    assert created["league_id"] != str(default_league.id)
    assert await _persisted_league_id(db_session, created["id"]) == str(other_league.id)


async def test_create_naming_a_league_that_does_not_exist_is_404_and_creates_nothing(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
):
    """A ``league_id`` that names no league is refused — loudly.

    The league a tournament runs on is a persisted fact that decides who may enter,
    not a view preference, so create reads it through the STRICT resolver (the same
    one the PATCH and ``matches.py`` use). Degrading to the default here — which the
    other resolver in ``app/leagues.py`` would do, and which it exists to do for the
    *profile* surfaces — would answer 201 to a director who mistyped an id, hand
    them a tournament quietly running on a ladder they never chose, and judge their
    entrants on it with nothing anywhere saying so. That is the silent lie ADR-0783
    exists to remove, so it is a 404.

    And a 404 that had already written the row would be a 404 in name only: the
    absence of the tournament is asserted, not assumed.
    """
    client, _ = authed_client

    response = await client.post(
        "/v1/tournaments", json=_create_payload(league_id=str(uuid.uuid4()))
    )

    assert response.status_code == 404, response.text
    assert response.json()["detail"] == "League not found."
    count = (
        await db_session.execute(select(func.count()).select_from(Tournament))
    ).scalar_one()
    assert count == 0


async def test_patch_moves_the_league_while_the_tournament_is_a_draft(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    default_league: League,
    other_league: League,
):
    """Nobody can have entered a draft, so nothing is re-judged by moving its
    ladder: the edit is allowed, answers with the new league, and persists."""
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    assert created["league_id"] == str(default_league.id)
    assert created["status"] == "draft"

    response = await client.patch(
        f"/v1/tournaments/{created['id']}",
        json={"league_id": str(other_league.id)},
    )

    assert response.status_code == 200, response.text
    assert response.json()["league_id"] == str(other_league.id)
    assert await _persisted_league_id(db_session, created["id"]) == str(other_league.id)
    # The edit moved the ladder and nothing else — in particular it did not move
    # the tournament along its lifecycle.
    assert response.json()["status"] == "draft"


@pytest.mark.parametrize(
    "status",
    [TournamentStatus.published, TournamentStatus.live, TournamentStatus.archived],
    ids=lambda s: s.value,
)
async def test_patch_league_once_published_is_refused_and_changes_nothing(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    default_league: League,
    other_league: League,
    status: TournamentStatus,
):
    """Once a tournament is out of ``draft``, its ladder is settled (ADR-0783).

    Publishing opens registration and makes eligibility live, so swapping the
    league underneath would silently re-judge — and could retroactively disqualify
    — players who already entered against the old one. So the PATCH is a 409 in
    ``published`` and in the two statuses beyond it, and the row still carries the
    league it was published with: a guard that refused *after* writing would pass a
    status-code-only assertion.

    409, not 403: the owner is permitted, the tournament is simply past the point
    where the edit means anything.
    """
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    await _set_status(db_session, created["id"], status)

    response = await client.patch(
        f"/v1/tournaments/{created['id']}",
        json={"league_id": str(other_league.id)},
    )

    assert response.status_code == 409, response.text
    assert "draft" in response.json()["detail"]
    assert await _persisted_league_id(db_session, created["id"]) == str(
        default_league.id
    )


async def test_patch_league_once_published_is_refused_even_with_the_same_league(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    default_league: League,
):
    """Re-sending the league a published tournament already has is a 409 too.

    The guard is on the *field being sent*, not on the value differing — the same
    shape as the transition route, where re-asserting the status you already hold
    is a conflict rather than an idempotent no-op (ADR-0017). The only caller that
    sends a settled field is a stale one, and a 200 would tell it the field is
    still editable when it is not.
    """
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    await _set_status(db_session, created["id"], TournamentStatus.published)

    response = await client.patch(
        f"/v1/tournaments/{created['id']}",
        json={"league_id": str(default_league.id)},
    )

    assert response.status_code == 409, response.text


async def test_patch_other_fields_still_work_once_published(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
):
    """The guard is on the league, not on editing a published tournament at all —
    the name (and everything else) is still the owner's to change."""
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    await _set_status(db_session, created["id"], TournamentStatus.published)

    response = await client.patch(
        f"/v1/tournaments/{created['id']}", json={"name": "Bay Area Major"}
    )

    assert response.status_code == 200, response.text
    assert response.json()["name"] == "Bay Area Major"


async def test_patch_league_that_names_no_league_is_404(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    default_league: League,
):
    """An id that names no league is a 404, not a silent fall back to the default.

    On the way in the league is a *choice the owner made*, not a view preference,
    so this reads through the STRICT resolver (``app/leagues.py``): substituting
    the default would run the tournament on a ladder nobody asked for. It also
    keeps a bogus id from reaching the NOT NULL FK as a 500.
    """
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()

    response = await client.patch(
        f"/v1/tournaments/{created['id']}",
        json={"league_id": str(uuid.uuid4())},
    )

    assert response.status_code == 404, response.text
    assert await _persisted_league_id(db_session, created["id"]) == str(
        default_league.id
    )


async def test_patch_explicit_null_league_returns_422(
    authed_client: tuple[AsyncClient, User],
):
    """``league_id`` backs a NOT NULL column, so "clear it" is not a thing a
    tournament can be asked to do — omitted and cleared are different."""
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()

    response = await client.patch(
        f"/v1/tournaments/{created['id']}", json={"league_id": None}
    )

    assert response.status_code == 422, response.text


# ----- entry_state: may THIS caller enter THIS event? (ADR-0783) --------------
#
# The detail page used to offer an Enter button on a full event, and on an event whose
# rules the player fails — both guaranteed 409s — because the page knew nothing about
# capacity or eligibility. Each event now carries the CALLER's ``entry_state``, decided
# by the same two functions the ``POST …/entries`` guards call
# (``app.tournament_eligibility``), so the page that explains the missing button and
# the route that refuses the entry cannot disagree.
#
# The states are asserted as WHOLE DICTS, not by picking ``["state"]`` out of them:
# ADR-0968 says the server sends a state and the client owns the copy, so an English
# sentence smuggled into this payload is a failure — and only an exact comparison
# catches an extra key nobody asked for.

CAP_UNDER_1500 = {"id": "pr-cap", "field": "rating", "op": "<", "value": 1500}
FLOOR_OVER_1600 = {"id": "pr-floor", "field": "rating", "op": ">=", "value": 1600}

OPEN: dict[str, Any] = {"state": "open"}
EVENT_FULL: dict[str, Any] = {"state": "event_full"}


def _ineligible(predicate_id: str, rating: float) -> dict[str, Any]:
    """The refusal as the wire carries it: WHICH rule refused you, and the rating it
    judged. Nothing else — no sentence for the client to render (ADR-0968), and no
    copy of the rule's ``op``/``value``, which the client already holds on the event's
    ``predicates`` and renders as chips. ``predicate_id`` is what points at the chip."""
    return {
        "state": "rating_ineligible",
        "predicate_id": predicate_id,
        "rating": rating,
    }


async def _tournament_with_events(
    client: AsyncClient, *events: dict[str, Any], **tournament: Any
) -> tuple[str, list[dict[str, Any]]]:
    """A tournament (on the default league unless ``tournament`` says otherwise) and
    its events, created through the real routes, in order."""
    created = (
        await client.post("/v1/tournaments", json=_create_payload(**tournament))
    ).json()
    made = [
        (
            await client.post(f"/v1/tournaments/{created['id']}/events", json=payload)
        ).json()
        for payload in events
    ]
    return created["id"], made


async def _events_of(client: AsyncClient, tournament_id: str) -> list[dict[str, Any]]:
    response = await client.get(f"/v1/tournaments/{tournament_id}")
    assert response.status_code == 200, response.text
    events: list[dict[str, Any]] = response.json()["events"]
    return events


async def test_entry_state_is_open_for_a_player_who_satisfies_the_events_rules(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """1400 against an "Under 1500" event with room in it: the event admits them."""
    client, user = authed_client
    await rate_player(db_session, user, default_league, 1400.0)
    tournament_id, _ = await _tournament_with_events(
        client, _event_payload(predicates=[CAP_UNDER_1500])
    )

    (event,) = await _events_of(client, tournament_id)

    assert event["entry_state"] == OPEN


async def test_entry_state_names_the_rule_that_refused_and_the_rating_it_judged(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """1650 against an "Under 1500" event: ``rating_ineligible``, carrying the id of
    the rule in the way and the number it was judged on — and NOTHING else.

    Those two facts are the minimum a client needs to say something honest ("this
    event is for players rated under 1500; you are 1650") without the server writing
    the sentence for it (ADR-0968): the rule itself is already on the event's
    ``predicates``, addressed by ``predicate_id``, and the rating is the one fact the
    page could not otherwise know.
    """
    client, user = authed_client
    await rate_player(db_session, user, default_league, 1650.0)
    tournament_id, _ = await _tournament_with_events(
        client, _event_payload(predicates=[CAP_UNDER_1500])
    )

    (event,) = await _events_of(client, tournament_id)

    assert event["entry_state"] == _ineligible("pr-cap", 1650.0)
    # And the rule that id points at is really on the event the client already has —
    # which is why the state does not repeat its operator and its number.
    assert [p["id"] for p in event["predicates"]] == ["pr-cap"]


async def test_one_caller_reads_open_on_one_event_and_ineligible_on_another(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """THE test: one player, one tournament, one response — and two different states.

    A 1650 player is too strong for the "Under 1500" event and exactly strong enough
    for the "1600 and over" one. If ``entry_state`` were a property of the *event*
    rather than of the (caller, event) pair — a global "is anybody eligible?" flag —
    both events would read the same thing here, and only this shape catches that.
    """
    client, user = authed_client
    await rate_player(db_session, user, default_league, 1650.0)
    tournament_id, _ = await _tournament_with_events(
        client,
        _event_payload(name="Under 1500", predicates=[CAP_UNDER_1500]),
        _event_payload(name="Championship", predicates=[FLOOR_OVER_1600]),
    )

    under_1500, championship = await _events_of(client, tournament_id)

    assert under_1500["entry_state"] == _ineligible("pr-cap", 1650.0)
    assert championship["entry_state"] == OPEN


async def test_a_full_event_reads_event_full_to_every_eligible_caller(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """Capacity is a fact about the EVENT, not about who is asking: once it holds its
    ``max_players`` entrants, every caller it would otherwise admit is told it is full
    — the creator, and a second player who has never touched it.

    The second event is the control, and it is the one that keeps this honest about
    ADR-0016: it has a cap of one and one *withdrawn* entry, and a withdrawn entry is
    not an entrant. Count the withdrawn row and this event reads full too — sealing an
    event that has room.
    """
    client, _ = authed_client
    tournament_id, (filled, freed) = await _tournament_with_events(
        client,
        _event_payload(name="Filled", max_players=1, predicates=[]),
        _event_payload(name="Freed up", max_players=1, predicates=[]),
    )
    await _enter(db_session, filled["id"], await make_user(db_session, "took-the-slot"))
    await _enter(
        db_session,
        freed["id"],
        await make_user(db_session, "gave-the-slot-back"),
        status=TournamentEntryStatus.withdrawn,
    )

    stranger = make_client()
    try:
        other = await start_session(stranger, db_session)
        await _grant_tournament_perms(db_session, other, (TOURNAMENT_VIEW,))
        for reader in (client, stranger):
            filled_read, freed_read = await _events_of(reader, tournament_id)
            assert filled_read["entry_state"] == EVENT_FULL, reader
            assert freed_read["entry_state"] == OPEN, reader
    finally:
        await stranger.aclose()


async def test_a_full_event_a_caller_could_never_enter_reads_rating_ineligible(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A full event whose rules the caller also fails reads ``rating_ineligible``, not
    ``event_full`` — the same precedence ``POST …/entries`` answers with
    (``test_the_rating_refusal_outranks_the_event_full_refusal``).

    The read and the guard must tell the player the same thing, and the rating is the
    more useful of the two facts: "full" invites them back when somebody withdraws, and
    the event would refuse them all over again.
    """
    client, user = authed_client
    await rate_player(db_session, user, default_league, 1650.0)
    tournament_id, (event,) = await _tournament_with_events(
        client, _event_payload(max_players=1, predicates=[CAP_UNDER_1500])
    )
    await _enter(db_session, event["id"], await make_user(db_session, "last-slot"))

    (read_event,) = await _events_of(client, tournament_id)

    assert read_event["entry_state"] == _ineligible("pr-cap", 1650.0)


async def test_an_unrated_caller_reads_open_on_a_capped_event(
    authed_client: tuple[AsyncClient, User],
) -> None:
    """**An unrated player is told the "Under 1500" event admits them** (ADR-0783 §3),
    and this is the read-side twin of the entry route's ``201``: the page must not hide
    the Enter button from the very beginner the beginners' event exists for.

    No ``rate_player`` call — but this is not a player with no rating ROW: minting their
    session joined them to the default league, which seeded a ``user_league_ratings``
    row at **1500** and an ``initial`` rating-history event before they had played
    anything. A read that keyed eligibility off ``rating_value`` would compare that
    seeded 1500 against ``rating < 1500``, and every beginner on the platform would see
    a "you are not eligible" notice on the beginners' event.
    """
    client, _ = authed_client
    tournament_id, _ = await _tournament_with_events(
        client, _event_payload(predicates=[CAP_UNDER_1500])
    )

    (event,) = await _events_of(client, tournament_id)

    assert event["entry_state"] == OPEN


async def test_entry_state_is_judged_on_the_tournaments_league_not_any_other(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    default_league: League,
    other_league: League,
) -> None:
    """The rating that decides an event's ``entry_state`` is the caller's rating on the
    **tournament's** ladder (ADR-0783) — the one it named — and on no other.

    A 1650 rating on the *default* league says nothing about a tournament run on the
    Bay Area ladder, where the same player is unrated: they read ``open``. Rate them on
    the ladder the tournament actually runs on and the same event refuses them. A read
    that grabbed "the player's rating" from wherever it could find one would answer
    ``rating_ineligible`` in both halves, and pass a test that only had the second.
    """
    client, user = authed_client
    await rate_player(db_session, user, default_league, 1650.0)
    tournament_id, _ = await _tournament_with_events(
        client,
        _event_payload(predicates=[CAP_UNDER_1500]),
        league_id=str(other_league.id),
    )

    (before,) = await _events_of(client, tournament_id)
    assert before["entry_state"] == OPEN

    await rate_player(db_session, user, other_league, 1650.0)

    (after,) = await _events_of(client, tournament_id)
    assert after["entry_state"] == _ineligible("pr-cap", 1650.0)


async def test_the_list_endpoint_reports_the_same_entry_state_as_the_detail(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The list returns the same aggregate the detail does, so it carries the same
    per-caller states — read through the batched rating loader rather than the
    single-league one. Two readers of one decision, and they agree."""
    client, user = authed_client
    await rate_player(db_session, user, default_league, 1650.0)
    tournament_id, _ = await _tournament_with_events(
        client,
        _event_payload(name="Under 1500", predicates=[CAP_UNDER_1500]),
        _event_payload(name="Championship", predicates=[FLOOR_OVER_1600]),
    )

    rows = (await client.get("/v1/tournaments")).json()
    listed = next(r for r in rows if r["id"] == tournament_id)

    assert [e["entry_state"] for e in listed["events"]] == [
        _ineligible("pr-cap", 1650.0),
        OPEN,
    ]
    assert [e["entry_state"] for e in listed["events"]] == [
        e["entry_state"] for e in await _events_of(client, tournament_id)
    ]


def test_the_entry_state_names_are_the_entry_refusal_codes() -> None:
    """The vocabulary the page reads and the vocabulary a refused ``POST`` answers with
    are ONE vocabulary (ADR-0968): a client holds one copy table for "why you cannot
    enter this event", whether it learned the reason from the read or from a 409.

    Renaming either side breaks this, which is the point — they are the same fact.
    """
    assert EventEntryFull().state == EntryRefusal.event_full.value
    assert (
        EventEntryRatingIneligible(predicate_id="pr-cap", rating=1650.0).state
        == EntryRefusal.rating_ineligible.value
    )


# ---------------------------------------------------------------------------
# The entrant's rating on the tournament's ladder — the unrated marker (ADR-0783 §3)
#
# An unrated player passes every rating rule, which makes a rating cap OPT-OUT: stay
# unrated, stay eligible for every capped event, forever. The agreed mitigation is not
# a guess at their strength — it is VISIBILITY. The director is the only person who can
# act on it (they can withdraw a ringer), and they can only act on what they can see, so
# each entrant carries the rating the event's rules would have judged them on, and
# ``null`` when we hold none.
#
# The trap these tests exist for: **"unrated" is not "rating_value IS NULL"**. Joining a
# league seeds a 1500 row, so a naive null check reports a confident 1500 for the very
# beginner — and the very sandbagger — the marker is for, and passes a shallow test
# while lying on the real thing.
# ---------------------------------------------------------------------------


async def _seed_only(db_session: AsyncSession, user: User, league: League) -> None:
    """Put ``user`` on ``league`` through the very function production joins them with
    (``seed_user_league_rating``) — the 1500 prior and an ``initial`` history row, and
    nothing else.

    This is the brand-new, session-minted player, reproduced. They HAVE a
    ``rating_value``, and it is 1500. They are nonetheless **Unrated**: nothing real has
    moved that number (``app.ratings.rated.is_rated_member``). It is the exact opposite
    of ``rate_player``, which is what a rating actually looks like — and the difference
    between the two is the whole of this section.
    """
    strategy = (
        await db_session.execute(
            select(RatingStrategy).where(RatingStrategy.id == league.rating_strategy_id)
        )
    ).scalar_one()
    seed_user_league_rating(db_session, league.id, user.id, strategy)
    await db_session.commit()


async def _rating_value_on_the_row(
    db_session: AsyncSession, user: User, league: League
) -> float | None:
    """What the COLUMN holds — read straight from the database, so a test that claims
    "seeded at 1500 yet reported unrated" is really testing that, and not a missing
    row."""
    return (
        await db_session.execute(
            select(UserLeagueRating.rating_value).where(
                UserLeagueRating.user_id == user.id,
                UserLeagueRating.league_id == league.id,
            )
        )
    ).scalar_one_or_none()


async def _entrants_of(client: AsyncClient, tournament_id: str) -> dict[str, Any]:
    """The single event's entrants, keyed by username."""
    (event,) = await _events_of(client, tournament_id)
    entrants: list[dict[str, Any]] = event["entrants"]
    return {e["username"]: e for e in entrants}


async def test_an_entrant_carries_their_rating_on_the_tournaments_ladder(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A rated entrant reports their number; an entrant with no rating at all reports
    ``null``. The two side by side are the whole feature: the director reads the list
    and sees who entered the capped event without a rating."""
    client, _ = authed_client
    ringer = await make_user(db_session, "ringer")
    await rate_player(db_session, ringer, default_league, 1875.0)
    stranger = await make_user(db_session, "stranger")  # never joined a league at all
    tournament_id, (event,) = await _tournament_with_events(
        client, _event_payload(predicates=[CAP_UNDER_1500])
    )
    await _enter(db_session, event["id"], ringer)
    await _enter(db_session, event["id"], stranger)

    entrants = await _entrants_of(client, tournament_id)

    assert entrants["ringer"]["rating"] == 1875.0
    assert entrants["stranger"]["rating"] is None


async def test_a_brand_new_player_entrant_is_unrated_not_their_seeded_1500(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """**THE trap.** A brand-new player — minted exactly as a session mints one, seeded
    with a 1500 ``rating_value`` and an ``initial`` history row — is reported
    ``rating: null``, not ``1500``.

    Key the marker off ``rating_value IS NULL`` and this is the test that fails and
    every other one still passes: the beginner (and the sandbagger beside them) shows a
    confident 1500 they have never played for, the director sees a full ladder with no
    holes in it, and the one mitigation ADR-0783 traded for the opt-out silently reports
    the opposite of the truth.

    The seeded row is asserted on the way in, so this cannot go green by accident on a
    player who simply has no row.
    """
    client, _ = authed_client
    beginner = await make_user(db_session, "beginner")
    await _seed_only(db_session, beginner, default_league)
    # The premise, proven: the column really does hold 1500 for them.
    seeded = await _rating_value_on_the_row(db_session, beginner, default_league)
    assert seeded == 1500.0, "the join seeds a 1500 prior; that is the trap"
    tournament_id, (event,) = await _tournament_with_events(
        client, _event_payload(predicates=[CAP_UNDER_1500])
    )
    await _enter(db_session, event["id"], beginner)

    entrants = await _entrants_of(client, tournament_id)

    assert entrants["beginner"]["rating"] is None, (
        "a seeded 1500 is a prior, not a rating — the entrant is Unrated"
    )
    # And they are LISTED. An unrated entrant that the outer join dropped would be
    # invisible to the director *and* uncounted (ADR-0016), quietly freeing a slot.
    assert set(entrants) == {"beginner"}


async def test_an_entrants_rating_is_read_on_the_tournaments_league_not_another(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    default_league: League,
    other_league: League,
) -> None:
    """The number beside an entrant's name is their rating on the ladder the tournament
    named (ADR-0783 §2) — the same ladder the event's rules judged them on. A rating
    earned somewhere else is not a rating here, and reporting one would tell the
    director a player is rated when the cap they slipped past could not see it."""
    client, _ = authed_client
    local = await make_user(db_session, "local-ladder")
    await rate_player(db_session, local, other_league, 1720.0)
    elsewhere = await make_user(db_session, "other-ladder")
    await rate_player(db_session, elsewhere, default_league, 1990.0)
    tournament_id, (event,) = await _tournament_with_events(
        client, _event_payload(), league_id=str(other_league.id)
    )
    await _enter(db_session, event["id"], local)
    await _enter(db_session, event["id"], elsewhere)

    entrants = await _entrants_of(client, tournament_id)

    assert entrants["local-ladder"]["rating"] == 1720.0
    # Rated 1990 — but on the DEFAULT league, which is not the ladder this tournament
    # runs on. Here they are Unrated, and the director must see that.
    assert entrants["other-ladder"]["rating"] is None


async def test_the_list_and_the_detail_agree_about_an_entrants_rating(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """Both reads go through the one batched loader, so the tournaments list cannot
    print a rating the detail page disagrees with."""
    client, _ = authed_client
    ringer = await make_user(db_session, "listed-ringer")
    await rate_player(db_session, ringer, default_league, 1650.0)
    unrated = await make_user(db_session, "listed-unrated")
    tournament_id, (event,) = await _tournament_with_events(client, _event_payload())
    await _enter(db_session, event["id"], ringer)
    await _enter(db_session, event["id"], unrated)

    rows = (await client.get("/v1/tournaments")).json()
    listed = next(r for r in rows if r["id"] == tournament_id)
    (listed_event,) = listed["events"]

    assert [(e["username"], e["rating"]) for e in listed_event["entrants"]] == [
        ("listed-ringer", 1650.0),
        ("listed-unrated", None),
    ]
    (detail_event,) = await _events_of(client, tournament_id)
    assert listed_event["entrants"] == detail_event["entrants"]


# The pin, measured: the tournament + username join, its events, ONE batched load of
# those events' active entrants (their ratings on the tournament's ladder ride along on
# that same statement — see ``active_entrants_by_event``), and ONE read of the caller's
# rating on the tournament's league. Four, whatever the number of events, and whatever
# the number of entrants in them.
EXPECTED_TOURNAMENT_DETAIL_STATEMENTS = 4


@pytest.mark.parametrize("event_count", [1, 4])
async def test_detail_statement_count_does_not_grow_with_events(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    engine: AsyncEngine,
    event_count: int,
) -> None:
    """Every event on the page now carries an ``entry_state`` judged against the
    caller's rating — and a tournament has exactly ONE ladder (ADR-0783), so that
    rating is read once for the whole page, not once per event.

    This is the trap the feature invites: resolving the rating (or counting capacity)
    inside the per-event loop is invisible in every assertion about the *response*, and
    turns a 12-event tournament's detail page into a dozen extra round-trips. A
    per-event rating would measure 5 statements at one event and 8 at four, so the
    four-event case fails the pin even if the one-event case slipped past.

    Counted on a fresh session against the handler, exactly as the list endpoint's twin
    does — see ``counted_statements``.
    """
    client, user = authed_client
    user_id = user.id  # read outside the counted block
    tournament_id, events = await _tournament_with_events(
        client,
        *(
            _event_payload(name=f"Event {n}", predicates=[CAP_UNDER_1500])
            for n in range(event_count)
        ),
    )
    for n, event in enumerate(events):
        await _enter(db_session, event["id"], await make_user(db_session, f"e-{n}"))

    async with counted_statements(engine) as (session, statements):
        detail = await get_tournament(
            tournament_id=uuid.UUID(tournament_id),
            db=session,
            current_user=User(id=user_id),
        )

    for n, statement in enumerate(statements, start=1):
        print(f"[{n}] {' '.join(statement.split())}")

    assert len(statements) == EXPECTED_TOURNAMENT_DETAIL_STATEMENTS, statements
    # And the block it counted really did the work: every event came back, with its
    # entrant and a state decided for the caller.
    assert len(detail.events) == event_count
    assert all(e.entered == 1 for e in detail.events)
    assert all(e.entry_state.state == "open" for e in detail.events)


@pytest.mark.parametrize("entrant_count", [1, 4])
async def test_detail_statement_count_does_not_grow_with_entrants(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    engine: AsyncEngine,
    default_league: League,
    entrant_count: int,
) -> None:
    """Every entrant now carries a rating of their OWN — not the caller's — so the read
    asks a question per *person on the page*, and the obvious way to answer it is a
    query per entrant. That is the N+1 this pin exists to catch.

    What this pin catches that the per-EVENT pins cannot is narrower than it looks,
    and worth stating exactly. A *plain* per-entrant N+1 would fire the per-event pins
    too — they assert an exact statement count, so any extra statement reds them. The
    shape only this pin can see is an N+1 **conditioned on being rated**: a query fired
    just for the entrants who have a rating. Every entrant in the per-event fixtures is
    unrated, so a rated-only query costs them nothing and they stay green while the
    real page pays a query per rated player. Hence the deliberate half-rated /
    half-unrated split below — a fixture that cannot hold a rated entrant cannot
    express the bug.

    The ratings ride along on the entrants' own batched statement
    (``active_entrants_by_event``), so the count is the same four — with the entrants
    spread across TWO events, so a loader that batched per event rather than across all
    of them is caught too.

    Half the entrants are rated and half are not, because the outer join is where a
    naive implementation would reach for a second query "just for the missing ones".
    """
    client, user = authed_client
    user_id = user.id  # read outside the counted block
    tournament_id, events = await _tournament_with_events(
        client,
        _event_payload(name="Event A"),
        _event_payload(name="Event B"),
    )
    for event in events:
        for n in range(entrant_count):
            entrant = await make_user(db_session, f"{event['name']}-entrant-{n}")
            if n % 2 == 0:
                await rate_player(db_session, entrant, default_league, 1500.0 + n)
            await _enter(db_session, event["id"], entrant)

    async with counted_statements(engine) as (session, statements):
        detail = await get_tournament(
            tournament_id=uuid.UUID(tournament_id),
            db=session,
            current_user=User(id=user_id),
        )

    for n, statement in enumerate(statements, start=1):
        print(f"[{n}] {' '.join(statement.split())}")

    assert len(statements) == EXPECTED_TOURNAMENT_DETAIL_STATEMENTS, statements
    # The counted block really did the work: every entrant came back, and the ratings
    # are the ones the batch loaded — not a page of uniform ``None``s that a broken
    # join would also produce.
    assert [e.entered for e in detail.events] == [entrant_count, entrant_count]
    entrants = [entrant for e in detail.events for entrant in e.entrants]
    assert [e.rating is not None for e in entrants] == [
        n % 2 == 0 for _ in detail.events for n in range(entrant_count)
    ]
