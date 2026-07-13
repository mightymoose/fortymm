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
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
import pytest_asyncio
from fastapi import HTTPException
from httpx import AsyncClient, Response
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.draws import DrawError
from app.leagues import seed_user_league_rating
from app.models import (
    League,
    LeagueVisibility,
    Match,
    MatchSettings,
    RatingStrategy,
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentFixture,
    TournamentStatus,
    User,
    UserLeagueRating,
)
from app.models.tournament import DrawType, EventFormat
from app.schemas.tournament import (
    EventEntryFull,
    EventEntryRatingIneligible,
    TournamentEventUpdate,
    TournamentTransitionCreate,
)
from app.tournament_draws import DrawCurrency, draw_currency_by_event
from app.tournament_entry_refusals import EntryRefusal
from app.tournaments import (
    TOURNAMENT_CREATE,
    TOURNAMENT_VIEW,
    _get_owned_tournament_or_404,
    _get_tournament_for_update_or_404,
    create_tournament_transition,
    cut_event_draw,
    get_tournament,
    list_tournaments,
    uncut_event_draw,
    update_event,
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


# ----- the player cap: a number, or none at all (ADR-0935) -------------------


async def test_create_event_with_null_max_players_is_uncapped(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
):
    """A ``null`` ``max_players`` means the event is uncapped (ADR-0935). The
    request succeeds, the response echoes ``null``, and the column actually holds
    NULL — not a fabricated ``0`` sentinel."""
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()

    response = await client.post(
        f"/v1/tournaments/{created['id']}/events",
        json=_event_payload(max_players=None),
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["max_players"] is None

    # Read the row back: the response is serialized from the refreshed ORM object,
    # so this confirms NULL landed in the column, not a coerced 0.
    row = (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == uuid.UUID(body["id"]))
        )
    ).scalar_one()
    assert row.max_players is None


async def test_create_event_with_zero_max_players_is_422(
    authed_client: tuple[AsyncClient, User],
):
    """A cap of ``0`` admits nobody — it is nonsense, not "no cap". The schema's
    ``gt=0`` rejects it at the boundary (ADR-0935); "no cap" is spelled ``null``."""
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()

    response = await client.post(
        f"/v1/tournaments/{created['id']}/events",
        json=_event_payload(max_players=0),
    )
    assert response.status_code == 422, response.text


async def test_event_negative_entry_fee_violates_db_check(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
):
    """The ``entry_fee >= 0`` CHECK is the load-bearing guard: even bypassing the
    Pydantic schema and writing straight through the ORM, a negative fee is
    refused by the database (ADR-0935)."""
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()

    event = TournamentEvent(
        tournament_id=uuid.UUID(created["id"]),
        name="Bad Fee",
        format=EventFormat.singles,
        draw_type=DrawType.single_elim,
        max_players=8,
        entry_fee=-1,
        slot={"date": "2026-06-13", "start": "09:00", "end": "18:00"},
        match_settings={"rated": True, "length_games": 5},
        predicates=[],
        pools=[],
    )
    db_session.add(event)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


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
    created_at: datetime | None = None,
    entry_id: uuid.UUID | None = None,
) -> TournamentEntry:
    """Persist an entry directly. The enter/withdraw *routes* land in #781/1c+1d;
    the read path can't wait for them, so it writes the rows itself.

    ``created_at`` is REGISTRATION ORDER, and the draw's ordering rule falls back to it
    for every unseeded entrant (ADR-0786). It is settable here so a test about that
    order can *state* the order rather than infer it from how fast the rows were
    written: left to the column's ``now()`` default, two entries written in the same
    breath differ by microseconds, and a draw asserted against that is a test that
    passes on the clock's goodwill.

    ``entry_id`` is settable for the same reason, one rung further down: the ordering
    rule's LAST tie-break is the entry id, so a draw test that leaves the ids to
    ``uuid4`` cannot tell "ordered by registration" from "ordered by id" except by
    luck — the two agree at random, and with a small field they agree often. Minting the
    ids in a *known* order (see the unseeded-registration-order draw test, which mints
    them backwards) is what makes the two rules distinguishable.
    """
    entry = TournamentEntry(
        event_id=uuid.UUID(event_id), user_id=user.id, status=status, seed=seed
    )
    if entry_id is not None:
        entry.id = entry_id
    if created_at is not None:
        entry.created_at = created_at
    db_session.add(entry)
    await db_session.commit()
    return entry


async def _cut(
    db_session: AsyncSession,
    event_id: str,
    *,
    round: int,
    position: int,
    pool_id: str | None = None,
    entry_a: TournamentEntry | None = None,
    entry_b: TournamentEntry | None = None,
) -> TournamentFixture:
    """Persist ONE fixture directly, at the coordinates given.

    Sides default to ``None`` — TBD, the state most of a freshly cut draw is in
    (ADR-0786) — and ``pool_id`` defaults to ``None``, an un-pooled fixture.

    It sits beside ``_enter`` because it is the same kind of thing: the way a test
    puts the database into a state the *routes* would take several acts to reach. The
    read-path tests needed it before a cut route existed; the statement-count pins need
    it to describe a *drawn* event; and the play-guard tests need it to write the one
    state nothing can produce yet (a fixture with a winner, or with a match).
    """
    fixture = TournamentFixture(
        event_id=uuid.UUID(event_id),
        pool_id=pool_id,
        round=round,
        position=position,
        entry_a_id=entry_a.id if entry_a is not None else None,
        entry_b_id=entry_b.id if entry_b is not None else None,
    )
    db_session.add(fixture)
    await db_session.commit()
    return fixture


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
# usernames join, the events, ONE batched load of every event's active entrants, ONE
# batched load of every event's fixtures — its draw (ADR-0786) — and ONE batched load of
# the caller's rating on every league those tournaments run on (which each event's
# ``entry_state`` is judged against, ADR-0783). Five, whatever the number of tournaments
# and events.
EXPECTED_TOURNAMENT_LIST_STATEMENTS = 5


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

    And every event here carries a **cut draw**, which is what makes the pin cover the
    fixtures loader at all. It did not, until it did: with no fixtures anywhere in the
    fixture, an N+1 conditioned on an event actually *having* a draw — ``if
    event.fixtures:`` in the serializer, a loader that skips the empty ones — cost this
    test nothing and left it green, while the real page paid a query per drawn event.
    A pin whose data has none of the thing it is pinning is not a pin. (The detail
    endpoint's twin, ``test_detail_statement_count_does_not_grow_with_drawn_events``,
    was written that way from the start; this one is now.)

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
        # Two fixtures per event — a DRAWN event (ADR-0786). Two, not one, so a loader
        # that read a single row per event would show up as missing data rather than as
        # a low count.
        await _cut(db_session, event["id"], pool_id="p-a", round=1, position=1)
        await _cut(db_session, event["id"], pool_id="p-a", round=1, position=2)

    async with counted_statements(engine) as (session, statements):
        # A transient ``User`` carrying only the id the handler reads: touching the
        # db_session-bound instance in here could emit a refresh SELECT on the same
        # engine and be counted as if the handler had issued it.
        listed = await list_tournaments(db=session, current_user=User(id=user_id))

    for n, statement in enumerate(statements, start=1):
        print(f"[{n}] {' '.join(statement.split())}")

    assert len(statements) == EXPECTED_TOURNAMENT_LIST_STATEMENTS, statements
    # And the block it counted really did the work: every event carries its own
    # entrants and its own draw, and the withdrawn player is nowhere.
    (tournament,) = [t for t in listed if str(t.id) == created["id"]]
    assert len(tournament.events) == event_count
    assert [e.entered for e in tournament.events] == list(range(1, event_count + 1))
    assert all(
        len(e.entrants) == e.entered
        and not any(x.username.startswith("gone-") for x in e.entrants)
        for e in tournament.events
    )
    assert all(
        [(f.pool_id, f.round, f.position) for f in e.fixtures]
        == [("p-a", 1, 1), ("p-a", 1, 2)]
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
    ``tournament.create``.

    The target is **published** first. What this test is about is the *permission*
    axis — read is granted, create is not — and a draft would answer 404 on the
    detail read for a reason that has nothing to do with permissions (#967: drafts
    are owner-only), quietly turning a permission test into a visibility one.
    """
    owner_client, _ = authed_client
    target = (await owner_client.post("/v1/tournaments", json=_create_payload())).json()
    await _set_status(db_session, target["id"], TournamentStatus.published)

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
    """A SECOND user who HAS view+create but did not create the **published**
    tournament: GET detail -> 200 with can_edit False; PATCH/DELETE and all event
    mutations -> 403 (owner-only).

    Permission grants the read; ownership grants the write — and the two are
    genuinely different answers for the same user on the same tournament, which is
    what this pins. The target is published first, because that read is only the
    non-owner's to have once the tournament has been *announced*: a draft is
    owner-only and answers 404 (#967, and the tests below), so leaving the target
    in draft would make this test agree with a router that had no ownership check
    in it at all — the 404 would fire before anything here was exercised.
    """
    owner_client, _ = authed_client
    target = (await owner_client.post("/v1/tournaments", json=_create_payload())).json()
    target_event = (
        await owner_client.post(
            f"/v1/tournaments/{target['id']}/events", json=_event_payload()
        )
    ).json()
    await _set_status(db_session, target["id"], TournamentStatus.published)

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


# ----- draft visibility (#967) ---------------------------------------------
#
# A draft has not been announced, so it is owner-only: absent from everyone else's
# list, and a 404 — not a 403 — on everyone else's detail read. The 404 is the
# point of the whole thing. A 403 would confirm that a tournament with that id
# exists, and the existence of an unannounced tournament is itself the secret; a
# draft nobody may see must be indistinguishable from one that was never created.
#
# ``tournament.view`` is the other axis and it is *unaffected*: the permission gate
# is a route dependency, so it still answers first, and a user without the grant is
# refused before visibility is ever consulted. The last test in this section is what
# holds those two apart.


async def _list_ids(client: AsyncClient) -> list[str]:
    """The ids in ``GET /v1/tournaments``, as the caller sees them.

    Every list assertion below is about *membership*, not about the status code: a
    predicate that filtered nothing, and one that filtered everything, both answer
    200 with a well-formed body. Only the ids say which one shipped.
    """
    response = await client.get("/v1/tournaments")
    assert response.status_code == 200, response.text
    return [t["id"] for t in response.json()]


async def test_another_users_draft_detail_is_a_404(
    db_session: AsyncSession,
    authed_client: tuple[AsyncClient, User],
):
    """A permitted non-owner reading someone else's DRAFT gets 404, not 403.

    The caller holds ``tournament.view`` — they are allowed to read tournaments —
    and the tournament plainly exists. It is still a 404, because the answer they
    are owed is the one they would get for an id that was never issued: the draft's
    existence is not theirs to learn. Assert on the *detail* string too, so a 404
    arriving for some unrelated reason (a mistyped route, say) can't pass this.
    """
    owner_client, _ = authed_client
    target = (await owner_client.post("/v1/tournaments", json=_create_payload())).json()
    assert target["status"] == TournamentStatus.draft.value

    async with make_client() as other_client:
        other = await start_session(other_client, db_session)
        await _grant_tournament_perms(db_session, other)

        response = await other_client.get(f"/v1/tournaments/{target['id']}")

    assert response.status_code == 404, response.text
    assert response.json()["detail"] == "Tournament not found."


async def test_another_users_draft_is_absent_from_the_list(
    db_session: AsyncSession,
    authed_client: tuple[AsyncClient, User],
):
    """The list is the other half of the same rule: a draft the caller doesn't own
    is not in it.

    Hiding the draft on the detail route alone would be worthless — the list is the
    surface that *announces* a tournament, and a card the caller can see but cannot
    open is a leak with a 404 stapled to it.
    """
    owner_client, _ = authed_client
    target = (await owner_client.post("/v1/tournaments", json=_create_payload())).json()

    async with make_client() as other_client:
        other = await start_session(other_client, db_session)
        await _grant_tournament_perms(db_session, other)

        assert target["id"] not in await _list_ids(other_client)


async def test_the_owner_still_sees_and_reads_their_own_draft(
    authed_client: tuple[AsyncClient, User],
):
    """The fix must not hide a draft from the person who is building it.

    The owner is the one caller a draft exists *for*: it is in their list, its
    detail reads back, and ``can_edit`` is true — the draft is still theirs to
    finish and publish. A predicate that hid every draft (rather than every draft
    that isn't yours) would pass both tests above and break the actual feature; this
    is the test that catches it.
    """
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    assert created["status"] == TournamentStatus.draft.value

    assert created["id"] in await _list_ids(client)

    detail = await client.get(f"/v1/tournaments/{created['id']}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["can_edit"] is True


async def test_a_published_tournament_is_visible_to_a_non_owner(
    db_session: AsyncSession,
    authed_client: tuple[AsyncClient, User],
):
    """The guard against over-filtering: publishing is what makes a tournament
    public, so once it is published a permitted non-owner sees it in their list.

    Both draft tests above are satisfied by a predicate that returns nothing at all.
    This one is not: it fails the moment the filter starts hiding tournaments that
    *have* been announced — which is the way this fix breaks in production, silently
    and only for other people's tournaments.
    """
    owner_client, _ = authed_client
    target = (await owner_client.post("/v1/tournaments", json=_create_payload())).json()
    await _set_status(db_session, target["id"], TournamentStatus.published)

    async with make_client() as other_client:
        other = await start_session(other_client, db_session)
        await _grant_tournament_perms(db_session, other)

        assert target["id"] in await _list_ids(other_client)
        assert (
            await other_client.get(f"/v1/tournaments/{target['id']}")
        ).status_code == 200


async def test_missing_permission_is_403_on_a_draft_even_though_it_is_invisible(
    db_session: AsyncSession,
    authed_client: tuple[AsyncClient, User],
):
    """The gate still fires FIRST: no ``tournament.view`` means 403, not the 404 the
    draft's invisibility would otherwise produce.

    The two refusals answer different questions and must not be collapsed. 403 says
    "you may not read tournaments"; 404 says "there is no such tournament for you".
    A user with no grant at all learns nothing either way — which is why the
    ordering is safe — but if visibility ever ran *before* the permission gate, a
    permission-less caller poking at ids would start getting 404s for drafts and
    403s for published tournaments, and could sit there enumerating which ids exist
    in which state. The gate is a route dependency precisely so it cannot get out of
    order.
    """
    owner_client, _ = authed_client
    target = (await owner_client.post("/v1/tournaments", json=_create_payload())).json()

    async with make_client() as client:
        await start_session(client, db_session)  # a session, but no permissions

        assert (await client.get(f"/v1/tournaments/{target['id']}")).status_code == 403
        assert (await client.get("/v1/tournaments")).status_code == 403


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


async def _event_with_entrants(
    client: AsyncClient,
    db_session: AsyncSession,
    tournament_id: str,
    *,
    name: str = "Open Singles",
    players: int = 2,
) -> tuple[str, list[TournamentEntry]]:
    """A **round-robin** event under ``tournament_id``, with ``players`` active entrants
    and **no draw yet** — the state a director is in just before they cut one.

    Round-robin because it is the one draw type with a strategy today, so this event can
    be handed to the real ``POST …/draw`` (``_cut_the_draw``): the go-live precondition
    is a claim about the fixtures the *cut route* writes, and a test that hand-rolled
    them with ``_cut`` would be asserting against a draw of its own invention.

    ``predicates=[]`` — the eligibility rules are not what is under test here, and the
    default payload's "under 1500" rule has nothing to say about the unrated players
    below.
    """
    created = await client.post(
        f"/v1/tournaments/{tournament_id}/events",
        json=_event_payload(name=name, draw_type="round-robin", predicates=[]),
    )
    assert created.status_code == 201, created.text
    event_id: str = created.json()["id"]
    entries = [
        await _enter(
            db_session,
            event_id,
            await make_user(db_session, f"player-{uuid.uuid4().hex[:12]}"),
        )
        for _ in range(players)
    ]
    return event_id, entries


async def _cut_the_draw(client: AsyncClient, tournament_id: str, event_id: str) -> None:
    """Cut the event's draw through the real route, so the fixtures the precondition
    reads are the fixtures the product writes."""
    response = await client.post(
        f"/v1/tournaments/{tournament_id}/events/{event_id}/draw"
    )
    assert response.status_code == 201, response.text


async def _withdraw(db_session: AsyncSession, entry: TournamentEntry) -> None:
    """Withdraw an entry the way the route does — a soft delete (ADR-0016), so the row
    (and every fixture pointing at it) survives."""
    entry.status = TournamentEntryStatus.withdrawn
    await db_session.commit()


async def _ready_to_start(
    client: AsyncClient, db_session: AsyncSession, *, players: int = 2
) -> tuple[str, str, list[TournamentEntry]]:
    """A tournament that could go live right now: one event, ``players`` entrants, and a
    draw cut from exactly them. Left in whatever status it was created in (``draft``) —
    the caller decides where on the lifecycle it sits."""
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    event_id, entries = await _event_with_entrants(
        client, db_session, created["id"], players=players
    )
    await _cut_the_draw(client, created["id"], event_id)
    return created["id"], event_id, entries


@pytest.mark.parametrize(("start", "target"), _edge_params(_LEGAL_EDGES))
async def test_transition_legal_edge_moves_the_tournament_and_persists(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    start: TournamentStatus,
    target: TournamentStatus,
):
    """Each of the three forward edges is accepted, answers with the moved
    tournament, and the move is still there on the next read.

    The tournament is built **ready to start** — an event, its entrants, and a draw cut
    from exactly them — because one of the three edges (``published → live``) now has a
    precondition, and a tournament with no draw cannot walk it (ADR-0786). The other two
    edges ask nothing of the draw and are indifferent to its presence
    (``test_publish_and_archive_ask_nothing_of_the_draws`` pins that they stay so).
    """
    client, _ = authed_client
    tournament_id, _event_id, _entries = await _ready_to_start(client, db_session)
    await _set_status(db_session, tournament_id, start)

    response = await client.post(
        f"/v1/tournaments/{tournament_id}/transitions", json={"to": target.value}
    )

    assert response.status_code == 201, response.text
    assert response.json()["status"] == target.value
    assert await _status_of(client, tournament_id) == target.value


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
    """Of the module's two loaders, only one locks:
    ``_get_tournament_for_update_or_404`` emits ``SELECT … FOR UPDATE``, and
    ``_get_owned_tournament_or_404`` — the loader behind the owner-only writes —
    does not.

    Both halves are load-bearing. A locking loader that quietly stopped locking
    would reopen the entry-after-go-live race in silence; and a lock spreading to
    the *other* loader would make PATCH/DELETE (and, were a read route ever to
    reach for it, every page view) queue behind writers they have nothing to
    serialize against.
    """
    client, owner = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    tournament_id = uuid.UUID(created["id"])

    async with counted_statements(engine) as (session, statements):
        await _get_tournament_for_update_or_404(session, tournament_id)
    assert any("FOR UPDATE" in s for s in statements), statements

    async with counted_statements(engine) as (session, statements):
        await _get_owned_tournament_or_404(session, tournament_id, owner)
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


# ----- the go-live precondition (ADR-0786) -----------------------------------
#
# ``published → live`` is the one edge with a precondition, and it hangs at the same
# dispatch point as the edge table itself (ADR-0017 reserved the spot). A tournament may
# only START with at least one event, each carrying a draw whose fixtures seat exactly
# its current entrants. Registration stays open right up to go-live, so "has a draw" is
# not enough: the draw has to still be a plan for the field that will play it.
#
# The tests below are written against the *set* of entrants, not their number, because
# that is the distinction the guard turns on — and the one a plausible-looking count
# check gets wrong (see ``test_a_swap_between_the_cut_and_go_live_is_stale``).


async def _go_live(client: AsyncClient, tournament_id: str) -> Any:
    return await client.post(
        f"/v1/tournaments/{tournament_id}/transitions", json={"to": "live"}
    )


async def test_going_live_with_no_events_is_refused(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
):
    """A tournament with **no events** cannot start: there is nothing to run.

    The case that makes the per-event rules below sound: "every event has a current
    draw" is *vacuously true* of a tournament with no events, so without this check an
    empty tournament would sail straight into ``live`` — the hole the #782 hand-off
    flagged, closed by ADR-0786.
    """
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    await _set_status(db_session, created["id"], TournamentStatus.published)

    response = await _go_live(client, created["id"])

    assert response.status_code == 409, response.text
    assert response.json()["detail"] == (
        "This tournament has no events, so there is nothing to start. Add an event "
        "and cut its draw, then start the tournament."
    )
    assert await _status_of(client, created["id"]) == "published"


async def test_publishing_a_tournament_with_no_events_still_succeeds(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
):
    """Announcing early is fine; starting nothing is not (ADR-0786).

    The other half of the rule above, and the half a guard placed on the *tournament*
    rather than on the ``live`` target would have broken: a director writes the events
    up after the dates are announced, and publishing is what opens registration.
    """
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()

    response = await client.post(
        f"/v1/tournaments/{created['id']}/transitions", json={"to": "published"}
    )

    assert response.status_code == 201, response.text
    assert response.json()["status"] == "published"
    assert await _status_of(client, created["id"]) == "published"


async def test_going_live_with_an_uncut_draw_names_the_event(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
):
    """An event nobody has cut a draw for refuses the whole tournament — and the refusal
    says **which** event, by name.

    A director with ten events cannot act on "some event has no draw", and the id the
    guard actually compared is not what they are looking at, so neither the event id nor
    any other raw uuid appears in the sentence.
    """
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    event_id, _entries = await _event_with_entrants(
        client, db_session, created["id"], name="Under 1200"
    )
    await _set_status(db_session, created["id"], TournamentStatus.published)

    response = await _go_live(client, created["id"])

    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert "“Under 1200” has no draw yet" in detail
    assert event_id not in detail
    assert await _status_of(client, created["id"]) == "published"


async def test_going_live_with_an_event_nobody_entered_is_refused(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
):
    """**The ∅ == ∅ case.** An event with *no entrants* and *no draw* is refused, by
    name, exactly as any other undrawn event is.

    It is the case a currency check written as "do the fixtures seat the entrants?" gets
    wrong in the *permissive* direction, and it is the only one where being wrong means
    a tournament starts: an event nobody has entered seats nobody and has nobody to
    seat, so the two sets compare **equal** — ∅ == ∅ — and a draw that does not exist
    reads as ``current``. The tournament goes live on an event that cannot be played
    (its draw could not even be cut: the strategy refuses a field that small).

    ``draw_currency_by_event`` therefore decides ``uncut`` on the **fixtures existing**,
    read off the rows, and not on the seated set being empty. That is a deliberate line
    of that function and this is the test that holds it there: rewrite the ``uncut`` arm
    as ``if not seated[event_id]`` — which passes every other go-live test in this file,
    because every one of them has entrants — and only this one reds.
    """
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    event_id, entries = await _event_with_entrants(
        client, db_session, created["id"], name="Under 1200", players=0
    )
    assert entries == [], "the whole point of this test is that NOBODY entered"
    await _set_status(db_session, created["id"], TournamentStatus.published)

    response = await _go_live(client, created["id"])

    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert "“Under 1200” has no draw yet" in detail
    assert event_id not in detail
    assert await _status_of(client, created["id"]) == "published"


async def test_an_entry_after_the_cut_makes_the_draw_stale_and_a_re_cut_fixes_it(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
):
    """The headline case: the draw was cut, and *then* somebody entered.

    The new player is in no fixture — they would sit out the tournament they entered —
    so the tournament is refused, by name, until the draw is cut again. And after the
    re-cut the very same request succeeds: the refusal is a *conflict* (409), not a
    permission (403), and the way out of it is exactly the one the sentence names.
    """
    client, _ = authed_client
    tournament_id, event_id, _entries = await _ready_to_start(client, db_session)
    await _set_status(db_session, tournament_id, TournamentStatus.published)
    # The late entrant, arriving after the draw was cut — which registration being open
    # in ``published`` makes an ordinary thing, not an exotic one.
    await _enter(db_session, event_id, await make_user(db_session, "late-arrival"))

    refused = await _go_live(client, tournament_id)

    assert refused.status_code == 409, refused.text
    detail = refused.json()["detail"]
    assert "“Open Singles” has a draw that no longer matches its entrants" in detail
    assert await _status_of(client, tournament_id) == "published"

    # The way out the refusal names: cut the draw again, from the field as it stands.
    await _cut_the_draw(client, tournament_id, event_id)
    started = await _go_live(client, tournament_id)

    assert started.status_code == 201, started.text
    assert await _status_of(client, tournament_id) == "live"


async def test_a_withdrawal_after_the_cut_makes_the_draw_stale(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
):
    """A player *leaving* after the cut is staleness too — the direction an
    "is everybody seated?" check would miss.

    The draw still seats the player who withdrew, so their opponents are holding
    fixtures nobody will play. Nothing is missing from the draw; something surplus is in
    it, and the set comparison catches that as readily as the other direction.
    """
    client, _ = authed_client
    tournament_id, event_id, entries = await _ready_to_start(
        client, db_session, players=3
    )
    await _set_status(db_session, tournament_id, TournamentStatus.published)

    await _withdraw(db_session, entries[0])

    response = await _go_live(client, tournament_id)

    assert response.status_code == 409, response.text
    assert (
        "“Open Singles” has a draw that no longer matches its entrants"
        in response.json()["detail"]
    )
    assert await _status_of(client, tournament_id) == "published"

    # And the re-cut still gets them started — with a draw for the field that is
    # actually there.
    await _cut_the_draw(client, tournament_id, event_id)
    assert (await _go_live(client, tournament_id)).status_code == 201


async def test_a_swap_between_the_cut_and_go_live_is_stale(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
):
    """**The discriminating case.** One player withdraws and another enters between the
    cut and go-live: the field has *the same number of players in it* and is not the
    same field.

    A currency check written as a count — "the draw has as many entrants as the event
    does" — passes this, and it is precisely the state that must not start: the draw
    seats a player who has left (their opponents get a match nobody will play) and seats
    the player who replaced them nowhere (they sit out the event they entered). The
    entrant *count* is asserted to be unchanged below, so this test fails the moment the
    guard is weakened into counting.
    """
    client, _ = authed_client
    tournament_id, event_id, entries = await _ready_to_start(client, db_session)
    await _set_status(db_session, tournament_id, TournamentStatus.published)

    before = await client.get(f"/v1/tournaments/{tournament_id}")
    assert before.json()["events"][0]["entered"] == 2

    # The swap: one out, one in. Same count, different people.
    await _withdraw(db_session, entries[0])
    await _enter(db_session, event_id, await make_user(db_session, "the-replacement"))

    after = await client.get(f"/v1/tournaments/{tournament_id}")
    assert after.json()["events"][0]["entered"] == 2, (
        "the whole point of this test is that the COUNT did not move"
    )

    response = await _go_live(client, tournament_id)

    assert response.status_code == 409, response.text
    assert (
        "“Open Singles” has a draw that no longer matches its entrants"
        in response.json()["detail"]
    )
    assert await _status_of(client, tournament_id) == "published"


async def test_the_refusal_names_every_offending_event_and_spares_the_ready_one(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
):
    """Three events — one ready, one never cut, one gone stale — and the refusal names
    the two that are broken, each under the sentence that says what is wrong with it.

    Two failures, two jobs: an uncut event needs a first cut; a stale one has a draw the
    director may have reviewed and approved, which is simply older than the field. And
    the event that IS ready is not named at all — a refusal that listed every event
    would send the director to re-cut a draw that is perfectly good.
    """
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    tournament_id = created["id"]

    ready_id, _ = await _event_with_entrants(
        client, db_session, tournament_id, name="Open Singles"
    )
    await _cut_the_draw(client, tournament_id, ready_id)

    await _event_with_entrants(client, db_session, tournament_id, name="Under 1200")

    stale_id, _ = await _event_with_entrants(
        client, db_session, tournament_id, name="Over 40s"
    )
    await _cut_the_draw(client, tournament_id, stale_id)
    await _enter(
        db_session, stale_id, await make_user(db_session, "over-40s-latecomer")
    )

    await _set_status(db_session, tournament_id, TournamentStatus.published)

    response = await _go_live(client, tournament_id)

    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert "“Under 1200” has no draw yet" in detail
    assert "“Over 40s” has a draw that no longer matches its entrants" in detail
    assert "Open Singles" not in detail
    assert await _status_of(client, tournament_id) == "published"


async def test_publish_and_archive_ask_nothing_of_the_draws(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
):
    """The precondition is on the ``live`` **target**, and nowhere else.

    A tournament whose events have no draws at all still publishes (registration has to
    open before anybody can enter, let alone be drawn) and still archives (a tournament
    that is over is not asked to tidy its draws before it can be put away). Only
    starting needs a draw.
    """
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()
    await _event_with_entrants(client, db_session, created["id"], name="Under 1200")

    published = await client.post(
        f"/v1/tournaments/{created['id']}/transitions", json={"to": "published"}
    )
    assert published.status_code == 201, published.text

    # Straight to ``live`` in the database — the edge under test here is the one *out*
    # of it, and walking in through the route would need the very draw this test is
    # asserting is not required.
    await _set_status(db_session, created["id"], TournamentStatus.live)
    archived = await client.post(
        f"/v1/tournaments/{created['id']}/transitions", json={"to": "archived"}
    )

    assert archived.status_code == 201, archived.text
    assert await _status_of(client, created["id"]) == "archived"


async def _hold_a_late_entry(
    session: AsyncSession,
    tournament_id: uuid.UUID,
    event_id: uuid.UUID,
    user_id: uuid.UUID,
) -> None:
    """A player's entry, taken up to but not including its commit — exactly as the entry
    route takes it: the **tournament's** row ``FOR UPDATE`` first, then the INSERT.

    That uncommitted instant is where the race lives, and holding it open is what lets
    the test below drive the interesting interleaving deterministically, instead of
    firing both sides and hoping the scheduler obliges — a ``gather`` of the two passes
    even against a *removed* guard, because go-live happens to win every time.

    """
    await session.execute(
        select(Tournament).where(Tournament.id == tournament_id).with_for_update()
    )
    session.add(TournamentEntry(event_id=event_id, user_id=user_id))
    await session.flush()


async def test_go_live_blocks_on_an_in_flight_entry_and_then_finds_the_draw_stale(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    engine: AsyncEngine,
):
    """The precondition is judged **inside the go-live row lock**, against the field as
    last *committed* — so an entry in flight cannot slip between the check and the
    ``UPDATE``.

    A player's entry holds the tournament's row lock, uncommitted, with its INSERT
    already made. The owner presses go-live — and *blocks*, because the transition route
    reads that same row ``FOR UPDATE`` (``starting.done()`` catches it if it does not).
    When the entry commits, go-live's read returns, its currency check runs on the
    field that now includes the new player, and it refuses: the draw seats one fewer
    player than the event has.

    Without the lock — or with the check hoisted above it — go-live would read the
    field from its own snapshot, certify a draw that was current *at that instant*,
    and commit. Both requests succeed, and the tournament starts on a draw that leaves
    a paying entrant in no fixture. READ COMMITTED offers nothing here; the shared lock
    on the tournament row is the entire mechanism, and this is the test that says so.
    """
    client, owner = authed_client
    tournament_id, event_id, _entries = await _ready_to_start(client, db_session)
    await _set_status(db_session, tournament_id, TournamentStatus.published)
    latecomer = await make_user(db_session, "the-latecomer")

    tournament_uuid = uuid.UUID(tournament_id)
    event_uuid = uuid.UUID(event_id)
    owner_id, latecomer_id = owner.id, latecomer.id
    make_session = async_sessionmaker(engine, expire_on_commit=False)

    async def go_live() -> int | str:
        async with make_session() as session:
            actor = (
                await session.execute(select(User).where(User.id == owner_id))
            ).scalar_one()
            try:
                moved = await create_tournament_transition(
                    tournament_uuid,
                    TournamentTransitionCreate(to=TournamentStatus.live),
                    session,
                    actor,
                )
                return moved.status.value
            except HTTPException as exc:
                return exc.status_code

    async with make_session() as entering:
        await _hold_a_late_entry(entering, tournament_uuid, event_uuid, latecomer_id)
        starting = asyncio.create_task(go_live())
        # Every chance to finish — and it cannot, because it is parked on the
        # tournament's row lock, inside the handler, before it has judged anything.
        await asyncio.sleep(0.25)
        if starting.done():
            pytest.fail(
                "go-live did not block on the tournament's row lock: it ran to "
                f"completion against an in-flight entry ({starting.result()!r})"
            )
        await entering.commit()
        outcome = await starting

    assert outcome == 409, outcome
    assert await _status_of(client, tournament_id) == "published"
    async with make_session() as verify:
        currency = (await draw_currency_by_event(verify, [event_uuid]))[event_uuid]
    assert currency is DrawCurrency.stale


async def test_two_events_each_with_a_current_draw_go_live_together(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """Currency is a fact about **one event**, and a tournament with two of them goes
    live when both are current.

    The precondition asks "do these fixtures seat exactly these entrants" of every event
    it is starting, and the loader answers for all of them in one batched pair of
    statements. Batched — so the two events' entries come back from the *same* query,
    and the whole of the correctness is in keying them apart afterwards. Read that
    result as one undifferentiated field and each event's draw is measured against
    **both** events' entrants: each seats four of the eight, each is called stale, and a
    tournament whose draws are both perfectly current is refused with a 409 telling the
    director to re-cut the draws they already cut. They could re-cut them all night.

    Every other currency test has a single event, where "the event's entries" and "every
    entry in the table" are the same set.
    (Measured: dropping the ``event_id.in_(...)`` filter from ``draw_currency_by_event``
    survived the entire suite.)
    """
    client, _ = authed_client
    tournament_id, (one, two) = await _tournament_with_events(
        client, _rr_payload(POOL_A, POOL_B), _rr_payload(POOL_A, POOL_B)
    )
    await _seed_field(db_session, one["id"], 4, prefix="one")
    await _seed_field(db_session, two["id"], 4, prefix="two")
    await _cut_the_draw(client, tournament_id, one["id"])
    await _cut_the_draw(client, tournament_id, two["id"])
    await _set_status(db_session, tournament_id, TournamentStatus.published)

    response = await _go_live(client, tournament_id)

    assert response.status_code == 201, response.text
    assert response.json()["status"] == "live"
    assert await _status_of(client, tournament_id) == "live"


async def test_going_live_is_undisturbed_by_another_tournaments_entries(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """A tournament goes live on **its own** field. Somebody else's entries are in the
    same table, and they must not reach the query that judges this one.

    The currency loader keys its result by the ``event_id`` on each row it reads, so an
    unfiltered read is not merely wasteful — it comes back holding rows for events the
    caller never asked about, and there is nowhere to put them. Not a wrong answer: no
    answer. A 500 on go-live, for every tournament in the database after the first one
    to take an entry.

    Which is precisely why no single-tournament test can see it. The suite truncates
    between tests, so "every entry in the table" and "this tournament's entries" are
    the same rows in almost every test written here — and this is the one where they
    are not.
    (Measured: dropping the ``event_id.in_(...)`` filter from ``draw_currency_by_event``
    survived the entire suite, including a two-event tournament going live.)
    """
    client, _ = authed_client
    tournament_id, _event_id, _entries = await _ready_to_start(client, db_session)
    await _set_status(db_session, tournament_id, TournamentStatus.published)

    # A wholly unrelated tournament, with an event and a field of its own. Nothing about
    # it is this tournament's business — including, especially, on the way to live.
    _other_id, (other_event,) = await _tournament_with_events(
        client, _rr_payload(POOL_A, POOL_B)
    )
    await _seed_field(db_session, other_event["id"], 4, prefix="other")

    response = await _go_live(client, tournament_id)

    assert response.status_code == 201, response.text
    assert response.json()["status"] == "live"
    assert await _status_of(client, tournament_id) == "live"


async def test_currency_of_no_events_is_an_empty_answer_and_no_query(
    engine: AsyncEngine,
) -> None:
    """``draw_currency_by_event`` of an empty list answers ``{}`` — and asks the
    database nothing at all to do it.

    The batch loader's contract is "two statements for the whole batch, whatever the
    number of events", and *none* is a number of events: a draft tournament with no
    events reaches the go-live precondition, and this is the loader it reaches. The
    short-circuit is the difference between an empty answer and an ``IN ()`` — a
    predicate that is not merely wasteful but false for every row, and which no version
    of this function should ever be asked to mean.

    The statement count is the assertion, not decoration: an implementation that dropped
    the guard would still return ``{}`` (there are no events to key the result by), and
    would pass every assertion but this one.
    """
    async with counted_statements(engine) as (session, statements):
        currency = await draw_currency_by_event(session, [])

    assert currency == {}
    assert statements == [], statements


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

    The tournament is **published** before the stranger reads it. That is not incidental
    to the assertion, it is a precondition of it: a draft is owner-only (#967), so a
    non-owner's read of one is a 404 and this test would fail for a reason that has
    nothing to do with capacity. Publishing is also the honest setup — an event nobody
    outside the organizer can see is not an event anybody is racing to enter.
    """
    client, _ = authed_client
    tournament_id, (filled, freed) = await _tournament_with_events(
        client,
        _event_payload(name="Filled", max_players=1, predicates=[]),
        _event_payload(name="Freed up", max_players=1, predicates=[]),
    )
    await _set_status(db_session, tournament_id, TournamentStatus.published)
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


async def test_an_uncapped_events_entry_state_is_never_event_full(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """An event with **no cap** (``max_players`` is ``null``, ADR-0935) reads ``open``
    however many players are in it — it can never read ``event_full``.

    The capped event beside it is the control, and it is what makes the assertion mean
    something: both events are read out of the SAME response, so a page that reported
    ``open`` for everything would fail on the capped one, and a page that read a null
    cap as ``0`` (or crashed on it) would fail on the uncapped one. Only a serializer
    that actually asks ``event_is_full`` — the same function ``POST …/entries`` asks,
    which is why the read and the guard cannot drift — answers both correctly.

    ``entered`` is asserted too: the uncapped event is genuinely full of people. It is
    ``open`` *because it has no limit*, not because the read forgot to count.
    """
    client, _ = authed_client
    tournament_id, (uncapped, capped) = await _tournament_with_events(
        client,
        _event_payload(name="All comers", max_players=None, predicates=[]),
        _event_payload(name="Capped", max_players=1, predicates=[]),
    )
    for index in range(3):
        await _enter(
            db_session, uncapped["id"], await make_user(db_session, f"crowd-{index}")
        )
    await _enter(db_session, capped["id"], await make_user(db_session, "took-the-slot"))

    uncapped_read, capped_read = await _events_of(client, tournament_id)

    assert uncapped_read["max_players"] is None
    assert uncapped_read["entered"] == 3
    assert uncapped_read["entry_state"] == OPEN
    assert capped_read["entry_state"] == EVENT_FULL


async def test_an_uncapped_event_still_refuses_a_caller_its_rules_bar(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """Uncapped is not "open to everyone" — it is "open to everyone the RULES admit".

    Capacity and eligibility are two independent questions, and dropping the cap answers
    only the first. A 1650 player still fails an "Under 1500" event that happens to have
    no player limit, and the state still names the rule that refused them. An
    implementation that took a null cap as a licence to short-circuit to ``open`` — a
    tempting one line — would pass every other uncapped test in this file and quietly
    offer an Enter button the entry route answers with a 409.
    """
    client, user = authed_client
    await rate_player(db_session, user, default_league, 1650.0)
    tournament_id, _ = await _tournament_with_events(
        client, _event_payload(max_players=None, predicates=[CAP_UNDER_1500])
    )

    (event,) = await _events_of(client, tournament_id)

    assert event["max_players"] is None
    assert event["entry_state"] == _ineligible("pr-cap", 1650.0)


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
# that same statement — see ``active_entrants_by_event``), ONE batched load of those
# events' fixtures — their draws (ADR-0786) — and ONE read of the caller's rating on the
# tournament's league. Five, whatever the number of events, whatever the number of
# entrants in them, and whatever the size of their draws.
EXPECTED_TOURNAMENT_DETAIL_STATEMENTS = 5


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


# ----- the draw on the detail page (ADR-0786) -------------------------------
#
# A draw is the event's **fixtures**: planned pairings, each at a (pool, round,
# position), whose sides may still be TBD. They ride on the tournament-detail BFF
# rather than on a ``GET …/draw`` of their own — one endpoint per page (root
# CLAUDE.md), so a bracket is never a second round-trip the page has to wait for.
#
# Nothing writes fixtures yet (the cut endpoint is 1c), so these tests write the rows
# themselves — exactly as the entrants tests did before the entry route existed.


def _coords(event: dict[str, Any]) -> list[tuple[str | None, int, int]]:
    """An event's draw as the sequence of coordinates it came back in."""
    return [(f["pool_id"], f["round"], f["position"]) for f in event["fixtures"]]


async def _events_by_name(
    client: AsyncClient, tournament_id: str
) -> dict[str, dict[str, Any]]:
    return {e["name"]: e for e in await _events_of(client, tournament_id)}


async def test_an_events_draw_comes_back_in_pool_round_position_order(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """The draw is ordered by the server, deterministically: pool, then round, then
    position — the three columns that identify a fixture within its draw.

    The rows are written in deliberately the WRONG order (round 2 before round 1, pool
    B before pool A, the KO fixture first of all), because insertion order is what a
    read that forgot to order by anything would come back in — and on a draw cut in one
    pass, insertion order and the right order would happen to coincide. A test seeded
    in the right order could not tell the two apart, and would pass against a read with
    no ORDER BY at all.

    The un-pooled fixture (``pool_id`` NULL — the KO stage of this rr-then-ko event)
    sorts LAST, after the pools that feed it. NULL is a real value in this domain ("this
    fixture belongs to no pool"), not a missing one, so it has a defined place in the
    order rather than an incidental one.
    """
    client, _ = authed_client
    tournament_id, (drawn, _) = await _tournament_with_events(
        client,
        _event_payload(name="Open Singles"),
        _event_payload(name="Under 1500"),
    )

    await _cut(db_session, drawn["id"], pool_id="p-b", round=2, position=1)
    await _cut(db_session, drawn["id"], pool_id=None, round=1, position=1)
    await _cut(db_session, drawn["id"], pool_id="p-b", round=1, position=2)
    await _cut(db_session, drawn["id"], pool_id="p-a", round=1, position=1)
    await _cut(db_session, drawn["id"], pool_id="p-b", round=1, position=1)

    events = await _events_by_name(client, tournament_id)

    assert _coords(events["Open Singles"]) == [
        ("p-a", 1, 1),
        ("p-b", 1, 1),
        ("p-b", 1, 2),
        ("p-b", 2, 1),
        (None, 1, 1),
    ]


async def test_an_event_whose_draw_is_uncut_carries_an_empty_list(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """An event with no draw is not an error and not a ``null`` — it is an event whose
    draw has not been cut, which is the normal state of every event ever created
    (cutting is an explicit act, ADR-0786). It answers ``[]``.

    Its neighbour on the same tournament *is* cut, so this also pins the grouping: a
    loader that batched the fixtures but lost the event key would spill one event's draw
    onto the other, and a test with a single event could not see that.
    """
    client, _ = authed_client
    tournament_id, (drawn, undrawn) = await _tournament_with_events(
        client,
        _event_payload(name="Open Singles"),
        _event_payload(name="Under 1500"),
    )
    await _cut(db_session, drawn["id"], pool_id="p-a", round=1, position=1)

    events = await _events_by_name(client, tournament_id)

    assert _coords(events["Open Singles"]) == [("p-a", 1, 1)]
    assert events["Under 1500"]["fixtures"] == []


async def test_a_tbd_side_comes_back_as_null_rather_than_a_missing_key(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """A fixture's ``null`` side is its whole meaning: **TBD** — the feeding fixture is
    not decided yet (ADR-0786). It must survive serialization as a ``null``, not be
    dropped from the payload as an absent key: a client cannot render a bracket slot it
    was never told about, and "the key is missing" and "the side is unknown" are not the
    same fact.

    ``winner_entry_id`` and ``match_id`` are the same story — undecided, and not yet a
    match. The exact key set is asserted, so a field silently dropped (or a username
    silently *added*) fails here.
    """
    client, _ = authed_client
    tournament_id, (event,) = await _tournament_with_events(client, _event_payload())
    ada = await make_user(db_session, "ada-drawn")
    entry = await _enter(db_session, event["id"], ada)
    await _cut(
        db_session, event["id"], pool_id="p-a", round=1, position=1, entry_a=entry
    )

    (read,) = await _events_of(client, tournament_id)
    (fixture,) = read["fixtures"]

    assert set(fixture) == {
        "id",
        "pool_id",
        "round",
        "position",
        "entry_a_id",
        "entry_b_id",
        "winner_entry_id",
        "match_id",
    }
    assert fixture["entry_a_id"] == str(entry.id)
    # The three facts that are not known yet — each present, each null.
    assert fixture["entry_b_id"] is None
    assert fixture["winner_entry_id"] is None
    assert fixture["match_id"] is None


async def test_a_fixtures_sides_are_entry_ids_the_events_entrants_list_resolves(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """The contract that lets the fixture carry ids alone: **every entry id a fixture
    names is on the same event's ``entrants`` list**, so a client joins the two and
    reads the player's name off the one copy of it.

    The fixture deliberately does NOT repeat the username. A second copy of a name is a
    field and its own derivation (api/CLAUDE.md), and the copy that drifts is the one a
    player reads off a bracket. This test is what makes that safe: it fails if a fixture
    can reference an entry the page cannot resolve.
    """
    client, _ = authed_client
    tournament_id, (event,) = await _tournament_with_events(client, _event_payload())
    ada = await make_user(db_session, "ada-seeded")
    grace = await make_user(db_session, "grace-seeded")
    ada_entry = await _enter(db_session, event["id"], ada)
    grace_entry = await _enter(db_session, event["id"], grace)
    await _cut(
        db_session,
        event["id"],
        pool_id="p-a",
        round=1,
        position=1,
        entry_a=ada_entry,
        entry_b=grace_entry,
    )

    (read,) = await _events_of(client, tournament_id)
    (fixture,) = read["fixtures"]

    entrants = {e["id"]: e["username"] for e in read["entrants"]}
    named = [fixture["entry_a_id"], fixture["entry_b_id"]]
    assert all(entry_id in entrants for entry_id in named), (named, entrants)
    assert [entrants[entry_id] for entry_id in named] == ["ada-seeded", "grace-seeded"]


async def test_the_list_and_the_detail_agree_about_an_events_draw(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """Both reads go through the one batched loader, so the tournaments list cannot show
    a draw the detail page disagrees with — including its order."""
    client, _ = authed_client
    tournament_id, (event,) = await _tournament_with_events(client, _event_payload())
    await _cut(db_session, event["id"], pool_id="p-b", round=1, position=1)
    await _cut(db_session, event["id"], pool_id="p-a", round=1, position=1)

    rows = (await client.get("/v1/tournaments")).json()
    listed = next(r for r in rows if r["id"] == tournament_id)
    (listed_event,) = listed["events"]
    (detail_event,) = await _events_of(client, tournament_id)

    assert _coords(listed_event) == [("p-a", 1, 1), ("p-b", 1, 1)]
    assert listed_event["fixtures"] == detail_event["fixtures"]


async def test_patching_an_event_answers_with_the_draw_it_still_has(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """A PATCH is not a re-cut (ADR-0786): the event's draw survives an edit, so the
    response carries it. Answering ``[]`` here would tell the director their draw had
    just been thrown away — and the page, which renders what the mutation returned,
    would show it that way."""
    client, _ = authed_client
    tournament_id, (event,) = await _tournament_with_events(client, _event_payload())
    await _cut(db_session, event["id"], pool_id="p-a", round=1, position=1)

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event['id']}",
        json={"name": "Renamed Singles"},
    )

    assert response.status_code == 200, response.text
    assert _coords(response.json()) == [("p-a", 1, 1)]


async def test_a_new_event_is_born_with_an_empty_draw(
    authed_client: tuple[AsyncClient, User],
) -> None:
    """An event one statement old cannot have a draw — fixtures are only ever written by
    the cut, an explicit act on an event that already exists (ADR-0786) — so create
    answers ``[]`` without asking the database."""
    client, _ = authed_client
    _, (event,) = await _tournament_with_events(client, _event_payload())

    assert event["fixtures"] == []


@pytest.mark.parametrize("event_count", [1, 4])
async def test_detail_statement_count_does_not_grow_with_drawn_events(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    engine: AsyncEngine,
    event_count: int,
) -> None:
    """Every event on the page now carries its draw, and the obvious way to fetch one
    is ``event.fixtures`` inside the serializer's loop — a SELECT per event, on the
    page whose whole job is to describe a field of events. That N+1 is invisible in
    every assertion about the *response*: the draws would all come back, correctly,
    and in the right order.

    What this pin catches that the two sibling pins cannot: **every event in their**
    fixtures has an *uncut* draw. So a fetch conditioned on an event actually having
    fixtures — or a loader that skipped the empty ones — costs them nothing and leaves
    them green, while the real page pays a query per drawn event. Hence the deliberate
    cut draw on every event here, and the two ``event_count`` cases: a per-event fetch
    measures 6 statements at one event and 9 at four, so it fails the pin at four even
    if it slipped past at one.
    """
    client, user = authed_client
    user_id = user.id  # read outside the counted block
    tournament_id, events = await _tournament_with_events(
        client,
        *(_event_payload(name=f"Event {n}") for n in range(event_count)),
    )
    for n, event in enumerate(events):
        entrant = await make_user(db_session, f"drawn-{n}")
        entry = await _enter(db_session, event["id"], entrant)
        # Two fixtures per event, so a loader that read only the first row per event
        # would show up as missing data rather than as a low count.
        await _cut(
            db_session, event["id"], pool_id="p-a", round=1, position=1, entry_a=entry
        )
        await _cut(db_session, event["id"], pool_id="p-a", round=1, position=2)

    async with counted_statements(engine) as (session, statements):
        detail = await get_tournament(
            tournament_id=uuid.UUID(tournament_id),
            db=session,
            current_user=User(id=user_id),
        )

    for n, statement in enumerate(statements, start=1):
        print(f"[{n}] {' '.join(statement.split())}")

    assert len(statements) == EXPECTED_TOURNAMENT_DETAIL_STATEMENTS, statements
    # And the counted block really did the work: every event came back with its own
    # two-fixture draw, in order.
    assert len(detail.events) == event_count
    assert all(
        [(f.pool_id, f.round, f.position) for f in e.fixtures]
        == [("p-a", 1, 1), ("p-a", 1, 2)]
        for e in detail.events
    )


# ----- cutting and un-cutting the draw (ADR-0786) ---------------------------
#
# ``POST …/events/{id}/draw`` cuts (or re-cuts) an event's draw; ``DELETE`` un-cuts it.
# Owner-only, refused on evidence of play, and never on the tournament's status.
#
# The draw itself is planned by ``app.draws``, whose rules (the snake deal, the circle
# method, byes-as-absence, the ordering) are pinned against literals in
# ``tests/test_draws.py``. What these tests own is everything the pure module cannot
# see: that the right FIELD reaches it (active entries, in the right order), that what
# comes back is PERSISTED (and replaces what was there), who may ask for it, and the
# guard that stops a played draw from being thrown away.

# The pools a round-robin event is cut across. Two, so the snake has somewhere to snake
# to and a fixture's ``pool_id`` is a ref that has to resolve against the right one.
POOL_A: dict[str, Any] = {
    "id": "p-a",
    "name": "Pool A",
    "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
    "table_ids": ["t1"],
}
POOL_B: dict[str, Any] = {
    "id": "p-b",
    "name": "Pool B",
    "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
    "table_ids": ["t2"],
}


def _rr_payload(*pools: dict[str, Any], **overrides: Any) -> dict[str, Any]:
    """A **round-robin** event over ``pools`` — the one draw type that has a strategy
    today (ADR-0786). The shared ``_event_payload`` is deliberately an ``rr-then-ko``,
    which has none, so a draw test that used it would be testing the 422.

    ``draw_type`` is overridable (the unimplemented-type tests need exactly this event
    with a different generator on it), so it goes through ``overrides``."""
    return _event_payload(
        **{"draw_type": "round-robin", "pools": list(pools), **overrides}
    )


def _draw_url(tournament_id: str, event_id: str) -> str:
    return f"/v1/tournaments/{tournament_id}/events/{event_id}/draw"


async def _seed_field(
    db_session: AsyncSession,
    event_id: str,
    count: int,
    *,
    prefix: str = "p",
    seeded: bool = True,
    seeds: Sequence[int] | None = None,
    descending_ids: bool = False,
) -> list[TournamentEntry]:
    """``count`` active entries, in a draw order this test *states* rather than races
    for: seeds 1..N by default, and staggered registration times besides.

    The draw's order is seed-ascending, then registration order (ADR-0786). Both are
    pinned here so the pool each entrant snakes into is a fact of the fixture, not of
    how quickly the rows happened to be inserted.

    Two knobs exist to make the ordering rules *distinguishable from each other*, which
    the default field deliberately cannot do — its seeds ascend in the same order its
    registrations do, so "ordered by seed" and "ordered by registration" deal the same
    draw and no assertion about the result can tell them apart:

    * ``seeds`` gives the seeds explicitly, so a test can hand the field a seed order
      that *contradicts* its registration order.
    * ``descending_ids`` mints the entry ids backwards, so the last tie-break (the id)
      disagrees with registration order too, rather than agreeing with it by chance.

    The returned list is always in REGISTRATION order, whatever the seeds and ids say.
    """
    start = datetime(2026, 6, 1, 9, 0, tzinfo=UTC)
    return [
        await _enter(
            db_session,
            event_id,
            await make_user(db_session, f"{prefix}{n}"),
            seed=(seeds[n - 1] if seeds is not None else n) if seeded else None,
            created_at=start + timedelta(minutes=n),
            entry_id=uuid.UUID(int=1_000 + count - n) if descending_ids else None,
        )
        for n in range(1, count + 1)
    ]


def _members_by_pool(
    rows: list[TournamentFixture],
) -> dict[str | None, set[uuid.UUID]]:
    """Who ended up in which pool — read back off the fixtures, because there is no pool
    membership table (ADR-0786): a pool *is* the fixtures drawn into it.

    Pool-aware, unlike ``_pairs``, and that matters more than it looks: the snake of
    four entrants over two pools is symmetric under reversal — deal them backwards and
    the set of PAIRS is identical, only the pool each pair sits in changes. A
    pairing-only assertion on a field that small therefore passes against a draw dealt
    in the wrong order, which is exactly the bug the ordering tests exist to catch.
    """
    members: dict[str | None, set[uuid.UUID]] = {}
    for row in rows:
        seated = {row.entry_a_id, row.entry_b_id} - {None}
        members.setdefault(row.pool_id, set()).update(
            entry_id for entry_id in seated if entry_id is not None
        )
    return members


async def _fixture_rows(
    db_session: AsyncSession, event_id: str
) -> list[TournamentFixture]:
    """The event's fixtures, straight from the database, in the canonical order.

    Read from the ROW, never from the response: a route that answered with a plan it
    never persisted would satisfy every assertion made about its body.
    """
    return list(
        (
            await db_session.execute(
                select(TournamentFixture)
                .where(TournamentFixture.event_id == uuid.UUID(event_id))
                .order_by(
                    TournamentFixture.pool_id.asc().nulls_last(),
                    TournamentFixture.round,
                    TournamentFixture.position,
                )
            )
        )
        .scalars()
        .all()
    )


def _snapshot(fixtures: Sequence[TournamentFixture]) -> list[tuple[Any, ...]]:
    """Every column of every fixture — the whole row, not a summary of it.

    What "the refusal changed nothing" has to mean: the same rows, with the same ids,
    holding the same values. A count would pass against a route that deleted the draw
    and re-cut an identically-shaped one, which is precisely the harm the play guard
    exists to prevent.
    """
    return [
        (
            f.id,
            f.event_id,
            f.pool_id,
            f.round,
            f.position,
            f.entry_a_id,
            f.entry_b_id,
            f.winner_entry_id,
            f.match_id,
        )
        for f in fixtures
    ]


def _pairs(fixtures: Sequence[TournamentFixture]) -> set[frozenset[uuid.UUID | None]]:
    """The pairings a draw actually contains, ignoring which side is which."""
    return {frozenset({f.entry_a_id, f.entry_b_id}) for f in fixtures}


async def _make_match(db_session: AsyncSession, creator: User, league: League) -> Match:
    """A bare match row — the thing a fixture *materializes* into (#788).

    Nothing creates one from a fixture yet, which is exactly why this exists: the play
    guard has to hold before the path that would trip it does, or it lands already
    broken.
    """
    match = Match(
        match_settings=MatchSettings(team_size=1, best_of=5, affects_rating=False),
        league_id=league.id,
        created_by_user_id=creator.id,
    )
    db_session.add(match)
    await db_session.commit()
    return match


async def test_cutting_a_draw_persists_the_fixtures_the_strategy_planned(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """The owner cuts a two-pool round-robin over five players, and the draw it plans is
    the draw that lands in the database.

    Five over two pools is the smallest field that exercises the whole substrate at
    once: the snake deals it unevenly (3 and 2, seeds 1/4/5 against 2/3 — the top two
    seeds land in different pools, which is what a snake is *for*), the odd pool needs
    the circle method's phantom, and the bye that phantom produces is an **absent row**
    rather than a fixture with a NULL side (ADR-0786) — so pool A's three rounds hold
    one fixture each, not two with a hole in one.

    Asserted against the DATABASE as well as the response, because a route that planned
    a draw and answered with it without ever writing it would pass every assertion about
    the body — and the next page load would show no draw at all.
    """
    client, _ = authed_client
    tournament_id, (event,) = await _tournament_with_events(
        client, _rr_payload(POOL_A, POOL_B)
    )
    p1, p2, p3, p4, p5 = await _seed_field(db_session, event["id"], 5)
    # A withdrawn player, who is not an entrant (ADR-0016) and must be in no fixture:
    # cutting a draw from a field that includes people who have LEFT the event would
    # seat somebody who is not playing, and size every pool against a field that does
    # not exist.
    await _enter(
        db_session,
        event["id"],
        await make_user(db_session, "gone"),
        status=TournamentEntryStatus.withdrawn,
    )

    response = await client.post(_draw_url(tournament_id, event["id"]))

    assert response.status_code == 201, response.text
    body = response.json()
    rows = await _fixture_rows(db_session, event["id"])
    # The response IS the persisted draw — same rows, same ids, same order.
    assert [uuid.UUID(f["id"]) for f in body] == [f.id for f in rows]
    # Pool A (seeds 1, 4, 5) is the odd one: three rounds, one fixture each, because the
    # entrant drawn against the phantom that round simply has no fixture. Pool B (seeds
    # 2, 3) is a single pairing. Ordered pool → round → position.
    assert [(f.pool_id, f.round, f.position) for f in rows] == [
        ("p-a", 1, 1),
        ("p-a", 2, 1),
        ("p-a", 3, 1),
        ("p-b", 1, 1),
    ]
    # All-play-all *within* each pool, and nobody paired across pools.
    assert _pairs(rows) == {
        frozenset({p1.id, p4.id}),
        frozenset({p1.id, p5.id}),
        frozenset({p4.id, p5.id}),
        frozenset({p2.id, p3.id}),
    }
    # Both sides of every round-robin fixture are known at the cut, and nothing is
    # played yet: no TBDs, no winners, no matches.
    assert all(
        f.entry_a_id is not None
        and f.entry_b_id is not None
        and f.winner_entry_id is None
        and f.match_id is None
        for f in rows
    )
    # Exactly the five active entrants are seated — so the withdrawn player, who has an
    # entry row in this very event, is in no fixture at all.
    seated = {f.entry_a_id for f in rows} | {f.entry_b_id for f in rows}
    assert seated == {p1.id, p2.id, p3.id, p4.id, p5.id}


async def test_an_unseeded_field_is_drawn_in_registration_order(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """Nothing sets a seed today (ADR-0786), so the draw a real club night gets is the
    one ordered by **registration order** — and this is the test that the entry rows'
    ``created_at`` is what reaches the planner, not the order Postgres felt like
    returning them in.

    Six unseeded players, registered 1→6, over two pools: the snake deals 1, 4, 5 into
    pool A and 2, 3, 6 into pool B.

    **The field is built to make every wrong order visibly wrong**, which takes some
    doing, and it is the whole substance of this test:

    * The **entry ids are minted backwards** (``descending_ids``), against registration
      order. The ordering rule's last tie-break IS the entry id, so a cut that never
      read ``created_at`` at all would fall through to the ids and deal a *different*
      draw — whereas with the ``uuid4`` ids the rest of the suite uses, the two orders
      agree at random, and a draw dealt by id looks right about one time in twenty.
      (Measured: dropping ``created_at`` from the planner's input survived this test.)
    * Six, not four. The four-over-two snake is **symmetric under reversal** — deal the
      field backwards and the same two pairs come out, sitting in each other's pools —
      so a reversed order is invisible to a pairing assertion on a field that small.
    * And the assertion is **pool-aware** (``_members_by_pool``), because who a player
      is drawn *against* is only half of what the snake decides; which pool they play
      in is the other half, and it is the half a symmetric mis-deal gets wrong.
    """
    client, _ = authed_client
    tournament_id, (event,) = await _tournament_with_events(
        client, _rr_payload(POOL_A, POOL_B)
    )
    field = await _seed_field(
        db_session, event["id"], 6, seeded=False, descending_ids=True
    )
    first, second, third, fourth, fifth, sixth = field
    # The ids really do disagree with the registrations — otherwise the test below is
    # asserting against two rules that happen to agree, and proves neither.
    assert [e.id for e in field] == sorted((e.id for e in field), reverse=True)

    response = await client.post(_draw_url(tournament_id, event["id"]))

    assert response.status_code == 201, response.text
    rows = await _fixture_rows(db_session, event["id"])
    assert _members_by_pool(rows) == {
        "p-a": {first.id, fourth.id, fifth.id},  # the snake's 1, 4, 5
        "p-b": {second.id, third.id, sixth.id},  # its 2, 3, 6
    }


async def test_a_seed_outranks_the_registration_it_contradicts(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """The cut orders the field by **seed** where one is set — and this is the test that
    the ``seed`` column is read at all.

    The seeds here run *backwards* against the registrations: the player who registered
    last is seed 1, and the one who registered first is seed 6. So the draw order is the
    reverse of the registration order, and the snake deals seeds 1, 4, 5 into pool A —
    which is to say the 6th, 3rd and 2nd players to register.

    Every other draw test in this file seeds its field 1..N in registration order,
    where the two rules agree and either one alone produces the right answer. Blank the
    seed on the way out of the database and all of them still pass; this one does not.
    (Measured — it is the mutant that survived: ``seed=None`` in
    ``active_draw_entrants``.)
    """
    client, _ = authed_client
    tournament_id, (event,) = await _tournament_with_events(
        client, _rr_payload(POOL_A, POOL_B)
    )
    # Registered 1st..6th; seeded 6th..1st.
    first, second, third, fourth, fifth, sixth = await _seed_field(
        db_session, event["id"], 6, seeds=[6, 5, 4, 3, 2, 1]
    )

    response = await client.post(_draw_url(tournament_id, event["id"]))

    assert response.status_code == 201, response.text
    rows = await _fixture_rows(db_session, event["id"])
    assert _members_by_pool(rows) == {
        # Draw order is 6, 5, 4, 3, 2, 1 (by seed), so the snake's 1st, 4th and 5th are
        # the players who registered 6th, 3rd and 2nd.
        "p-a": {sixth.id, third.id, second.id},
        "p-b": {fifth.id, fourth.id, first.id},
    }


async def test_the_cut_reads_only_the_field_of_the_event_it_is_cutting(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """A cut reads **this event's** entrants. Not the tournament's, and not the table's.

    Two events under one tournament, each with its own four players. Cutting the first
    must seat exactly its own four — and the second event, whose draw nobody asked for,
    must still have none.

    Every other draw test in this file builds a tournament with a **single** event, and
    against a single event a cut that forgot to filter by ``event_id`` at all is
    indistinguishable from a correct one: the only entries in the table are the ones it
    should have read. This is the test that can tell the difference, and it is the
    difference between a draw and a draw with eight strangers in it.
    (Measured: dropping ``TournamentEntry.event_id == event_id`` from
    ``active_draw_entrants``'s WHERE survived the entire suite.)
    """
    client, _ = authed_client
    tournament_id, (event, other) = await _tournament_with_events(
        client, _rr_payload(POOL_A, POOL_B), _rr_payload(POOL_A, POOL_B)
    )
    ours = await _seed_field(db_session, event["id"], 4, prefix="ours")
    theirs = await _seed_field(db_session, other["id"], 4, prefix="theirs")

    response = await client.post(_draw_url(tournament_id, event["id"]))

    assert response.status_code == 201, response.text
    rows = await _fixture_rows(db_session, event["id"])
    seated = {f.entry_a_id for f in rows} | {f.entry_b_id for f in rows}
    assert seated == {entry.id for entry in ours}
    assert not seated & {entry.id for entry in theirs}
    # Two pools of two: one fixture each. Eight entrants would have made six.
    assert len(rows) == 2
    # And the event nobody cut has no draw. A cut is one event's business.
    assert await _fixture_rows(db_session, other["id"]) == []


async def test_a_second_cut_replaces_the_draw_wholesale(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """Re-cutting after the field changed **replaces** the draw: the old fixtures are
    gone — their ids with them — not amended in place, and not merely added to.

    That is the whole promise of the explicit cut (ADR-0786): a draw is a plan made
    against a field, so when the field changes the plan is re-made. A reconcile that
    kept the old rows and updated their sides would be the same draw wearing the same
    ids while seating different people — the fixture a director bookmarked would
    silently become somebody else's match.

    Asserted by IDENTITY, not by shape: the id sets before and after are disjoint, and
    every old id is gone from the table. A count would pass against a route that left
    the two old fixtures alone and appended the new ones, which is exactly the bug.
    """
    client, _ = authed_client
    tournament_id, (event,) = await _tournament_with_events(
        client, _rr_payload(POOL_A, POOL_B)
    )
    await _seed_field(db_session, event["id"], 4)

    first_cut = await client.post(_draw_url(tournament_id, event["id"]))
    assert first_cut.status_code == 201, first_cut.text
    before = {f.id for f in await _fixture_rows(db_session, event["id"])}
    # Two pools of two: one fixture each.
    assert len(before) == 2

    # A fifth player enters after the cut — the draw is now STALE, which is the whole
    # reason to re-cut.
    await _enter(
        db_session,
        event["id"],
        await make_user(db_session, "latecomer"),
        seed=5,
        created_at=datetime(2026, 6, 1, 10, 0, tzinfo=UTC),
    )

    second_cut = await client.post(_draw_url(tournament_id, event["id"]))

    assert second_cut.status_code == 201, second_cut.text
    rows = await _fixture_rows(db_session, event["id"])
    after = {f.id for f in rows}
    # Not one row of the old draw survived — disjoint id sets, and the old ids are not
    # merely displaced, they are DELETED.
    assert after.isdisjoint(before), (before, after)
    survivors = (
        await db_session.execute(
            select(func.count())
            .select_from(TournamentFixture)
            .where(TournamentFixture.id.in_(before))
        )
    ).scalar_one()
    assert survivors == 0
    # And the new draw is the one the new field implies: pool A now holds three players
    # (three fixtures), pool B two (one).
    assert [(f.pool_id, f.round, f.position) for f in rows] == [
        ("p-a", 1, 1),
        ("p-a", 2, 1),
        ("p-a", 3, 1),
        ("p-b", 1, 1),
    ]
    assert {uuid.UUID(f["id"]) for f in second_cut.json()} == after
    # The page shows the same thing the mutation answered with — same rows, same order.
    (read,) = await _events_of(client, tournament_id)
    assert read["fixtures"] == second_cut.json()


async def test_un_cutting_deletes_the_draw_and_is_idempotent(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """DELETE removes the event's fixtures and leaves everything else standing — and
    doing it twice is still a 204.

    An event with no draw is already in the state the second DELETE asks for, and this
    is a DELETE: asking for a state the resource already holds is a success, not a 404
    (the same reasoning that makes withdrawing an already-withdrawn entry a 204).
    """
    client, _ = authed_client
    tournament_id, (event,) = await _tournament_with_events(
        client, _rr_payload(POOL_A, POOL_B)
    )
    entries = await _seed_field(db_session, event["id"], 4)
    await client.post(_draw_url(tournament_id, event["id"]))
    assert await _fixture_rows(db_session, event["id"]) != []

    response = await client.delete(_draw_url(tournament_id, event["id"]))

    assert response.status_code == 204, response.text
    assert await _fixture_rows(db_session, event["id"]) == []
    # The entrants are untouched — un-cutting a draw un-does the DRAW, not the field.
    (read,) = await _events_of(client, tournament_id)
    assert read["fixtures"] == []
    assert {e["id"] for e in read["entrants"]} == {str(e.id) for e in entries}

    # Again: the event has no draw, and that is what was asked for.
    again = await client.delete(_draw_url(tournament_id, event["id"]))
    assert again.status_code == 204, again.text


# ----- who may cut ----------------------------------------------------------


async def test_a_non_owner_cannot_cut_or_un_cut_a_draw(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """Cutting a draw is a property of OWNING the tournament — no permission grants it.

    The stranger here holds ``tournament.view`` + ``tournament.create``, so they are a
    fully-permitted user of the platform; what they are not is the director of this
    tournament. Both verbs answer 403, and the standing draw is untouched — a refusal
    that had deleted the fixtures first would be a 403 in name only.
    """
    owner_client, _ = authed_client
    tournament_id, (event,) = await _tournament_with_events(
        owner_client, _rr_payload(POOL_A, POOL_B)
    )
    await _seed_field(db_session, event["id"], 4)
    await owner_client.post(_draw_url(tournament_id, event["id"]))
    before = _snapshot(await _fixture_rows(db_session, event["id"]))

    async with make_client() as stranger:
        user = await start_session(stranger, db_session)
        await _grant_tournament_perms(db_session, user)

        assert (
            await stranger.post(_draw_url(tournament_id, event["id"]))
        ).status_code == 403
        assert (
            await stranger.delete(_draw_url(tournament_id, event["id"]))
        ).status_code == 403

    assert _snapshot(await _fixture_rows(db_session, event["id"])) == before


async def test_an_anonymous_caller_cannot_cut_or_un_cut_a_draw(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """No session, no draw: both verbs are 401 before ownership is even a question."""
    owner_client, _ = authed_client
    tournament_id, (event,) = await _tournament_with_events(
        owner_client, _rr_payload(POOL_A, POOL_B)
    )
    await _seed_field(db_session, event["id"], 4)
    await owner_client.post(_draw_url(tournament_id, event["id"]))
    before = _snapshot(await _fixture_rows(db_session, event["id"]))

    async with make_client() as anonymous:  # no ``start_session``: no cookie at all
        assert (
            await anonymous.post(_draw_url(tournament_id, event["id"]))
        ).status_code == 401
        assert (
            await anonymous.delete(_draw_url(tournament_id, event["id"]))
        ).status_code == 401

    assert _snapshot(await _fixture_rows(db_session, event["id"])) == before


@pytest.mark.parametrize("verb", ["post", "delete"])
async def test_a_draw_on_a_tournament_or_event_that_does_not_exist_is_404(
    authed_client: tuple[AsyncClient, User],
    verb: str,
) -> None:
    """404 before 403 before 409 (ADR-0017), and the event must belong to the named
    tournament: a right event id under the wrong tournament id is not addressable
    through this URL, so it is a 404 rather than a cut of the event the caller did not
    name."""
    client, _ = authed_client
    tournament_id, (event,) = await _tournament_with_events(
        client, _rr_payload(POOL_A, POOL_B)
    )
    other_id, _ = await _tournament_with_events(client)
    missing = str(uuid.uuid4())
    call = getattr(client, verb)

    assert (await call(_draw_url(missing, event["id"]))).status_code == 404
    assert (await call(_draw_url(tournament_id, missing))).status_code == 404
    # The event exists, and so does the tournament — but not together.
    assert (await call(_draw_url(other_id, event["id"]))).status_code == 404


# ----- the draws this event cannot produce (422) ----------------------------


@pytest.mark.parametrize(
    "draw_type", ["single-elim", "double-elim", "rr-then-ko", "swiss"]
)
async def test_cutting_an_unimplemented_draw_type_is_422(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    draw_type: str,
) -> None:
    """Only round-robin has a strategy today (ADR-0786). The other four are a designed
    422 that NAMES the draw type — not a 500 from an unhandled exception, and not an
    empty draw the director would have to notice was empty.

    422, because the request is well-formed and authorized: it is this event's *content*
    — the draw type it was configured with — that cannot become a draw. Nothing is
    written, and the field is left alone.
    """
    client, _ = authed_client
    tournament_id, (event,) = await _tournament_with_events(
        client, _rr_payload(POOL_A, POOL_B, draw_type=draw_type)
    )
    await _seed_field(db_session, event["id"], 4)

    response = await client.post(_draw_url(tournament_id, event["id"]))

    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    assert draw_type in detail, detail
    # The sentence is for the director, and it says what to do about it. It is NOT the
    # exception's own ("… is not implemented yet"), which is written for the developer
    # who has to go implement it.
    assert "cannot be cut yet" in detail, detail
    assert await _fixture_rows(db_session, event["id"]) == []


@pytest.mark.parametrize(
    ("pools", "entrants", "expected"),
    [
        pytest.param(
            (),
            4,
            "A round-robin draw needs at least one pool.",
            id="no-pools",
        ),
        pytest.param(
            (POOL_A, POOL_B),
            3,
            "3 entrants across 2 pool(s) would leave a pool with fewer than 2 "
            "entrants, who would have nobody to play.",
            id="a-pool-of-one",
        ),
        pytest.param(
            (POOL_A,),
            0,
            "0 entrants across 1 pool(s) would leave a pool with fewer than 2 "
            "entrants, who would have nobody to play.",
            id="no-entrants-at-all",
        ),
    ],
)
async def test_cutting_a_draw_that_is_not_a_competition_is_422(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    pools: tuple[dict[str, Any], ...],
    entrants: int,
    expected: str,
) -> None:
    """A draw the domain will not produce, because it would not be a competition: an
    event with no pools to deal into, a field too small for the pools it has (somebody
    would be alone in a pool, with nobody to play), and the empty field that is both.

    Each is a 422 whose ``detail`` names the numbers the director has to change — the
    pool count and the size of the field — because "invalid draw" tells them nothing
    about which of the two to move.

    And each writes NOTHING. That is the property the re-cut path depends on: the plan
    is made before the old draw is deleted, so a refusal cannot leave an event with the
    fixtures it had thrown away and none of the ones it could not make.
    """
    client, _ = authed_client
    tournament_id, (event,) = await _tournament_with_events(client, _rr_payload(*pools))
    await _seed_field(db_session, event["id"], entrants)

    response = await client.post(_draw_url(tournament_id, event["id"]))

    assert response.status_code == 422, response.text
    assert response.json()["detail"] == expected
    assert await _fixture_rows(db_session, event["id"]) == []


async def test_a_draw_error_nobody_wrote_copy_for_refuses_without_leaking_its_message(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A ``DrawError`` subclass this route has never heard of is still a designed 422 —
    with a **generic** sentence, never the exception's own.

    ``_draw_refusal`` matches on the two errors that exist today and composes copy for
    each. Its fallback arm is what a *third* one hits, and the rule there is that a
    message written for a developer (or worse, one carrying a table name, a pool ref, a
    line number) must not become the sentence a director reads. Refusing vaguely is a
    bug report someone files; leaking internals is a defect that has already reached the
    UI.

    The only honest way to raise the base error is to invent the subclass the domain
    does not have yet — which is precisely the future this arm exists for. A ``500``
    here would be the alternative, and the 500 is the thing to avoid: the domain
    *refused*, and a refusal is an answer.
    """
    client, _ = authed_client
    tournament_id, (event,) = await _tournament_with_events(
        client, _rr_payload(POOL_A, POOL_B)
    )
    await _seed_field(db_session, event["id"], 4)

    class SwissRoundNotSettled(DrawError):
        """The DrawError of some slice that has not been written."""

    async def _raise_an_unknown_draw_error(
        db: AsyncSession, event: TournamentEvent
    ) -> None:
        raise SwissRoundNotSettled(
            "tournament_fixtures.pool_id='p-a' has a NULL seat at (round=2, position=1)"
        )

    monkeypatch.setattr("app.tournaments.cut_draw", _raise_an_unknown_draw_error)

    response = await client.post(_draw_url(tournament_id, event["id"]))

    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    assert detail == "This event's draw cannot be cut as the event stands."
    # Not one word of the exception's own message — not the column, not the ref, not the
    # coordinates. The generic arm means generic.
    assert "pool_id" not in detail
    assert "NULL" not in detail
    assert "p-a" not in detail
    # And, like every other refusal on this path, it writes nothing.
    assert await _fixture_rows(db_session, event["id"]) == []


async def test_a_refused_re_cut_leaves_the_standing_draw_untouched(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """The 422 that matters most: an event that HAS a draw, re-cut into a configuration
    the domain refuses.

    Two players withdraw from a cut two-pool event, leaving a field of two that cannot
    fill two pools. The re-cut is refused — and the draw the event already had is still
    there, row for row. A director who mis-clicks into a refusal must not lose the draw
    they had; the 422 has to be a refusal, not a demolition that failed to rebuild.

    What this test can and cannot see, stated because it was measured: the property has
    **two** independent protections — ``cut_draw`` plans before it deletes, and the
    route rolls the transaction back — so removing *either one* leaves this test green
    (both were mutated; both stayed green). It fails only against a cut that deleted the
    old draw and **committed** before planning the new one, which is the shape the bug
    actually takes when somebody makes a service function commit for convenience. Read
    its green as "the draw survives a 422", not as "the ordering in ``cut_draw`` is
    pinned" — it isn't, and the comment there says so.
    """
    client, _ = authed_client
    tournament_id, (event,) = await _tournament_with_events(
        client, _rr_payload(POOL_A, POOL_B)
    )
    entries = await _seed_field(db_session, event["id"], 4)
    await client.post(_draw_url(tournament_id, event["id"]))
    before = _snapshot(await _fixture_rows(db_session, event["id"]))
    assert before != []

    for entry in entries[:2]:
        entry.status = TournamentEntryStatus.withdrawn
    await db_session.commit()

    response = await client.post(_draw_url(tournament_id, event["id"]))

    assert response.status_code == 422, response.text
    assert _snapshot(await _fixture_rows(db_session, event["id"])) == before


# ----- the play guard (409) -------------------------------------------------


@pytest.mark.parametrize("evidence", ["winner", "match"])
@pytest.mark.parametrize("verb", ["post", "delete"])
async def test_a_played_draw_can_be_neither_re_cut_nor_un_cut(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    default_league: League,
    evidence: str,
    verb: str,
) -> None:
    """Evidence of play seals the draw — for BOTH verbs, and for both kinds of evidence.

    A cut replaces the draw wholesale and an un-cut destroys it, so either one, run
    over a fixture that has been played, throws away a result a player actually
    produced. The refusal is a 409: the caller is the owner and the draw is theirs; it
    is the draw that is past the point where re-cutting means anything.

    The two kinds of evidence are deliberately not one:

    * a **recorded winner** — the fixture is decided;
    * a **linked match** — the fixture has materialized, and that match may already
      carry games on its scratchpad or a proposed result. This half is why the guard is
      *stricter* than "matches already played" (issue #785's phrasing): the draw must
      never silently eat entered scores, and a match with a score on it is not
      something the API can tell apart from one without, from here.

    Nothing can *produce* either state yet — materialization is #788 — so the test
    writes it directly. That is the point of writing the guard now: it has to be
    standing before the path that trips it exists, or it lands already broken.

    The refusal must leave the draw **byte-for-byte** unchanged: every id, every side,
    every column (``_snapshot``). "Still some rows" would pass against a route that
    deleted the draw and re-cut an identical-looking one, and the ids the results hang
    off would be gone.
    """
    client, owner = authed_client
    tournament_id, (event,) = await _tournament_with_events(
        client, _rr_payload(POOL_A, POOL_B)
    )
    await _seed_field(db_session, event["id"], 4)
    await client.post(_draw_url(tournament_id, event["id"]))

    played, *_ = await _fixture_rows(db_session, event["id"])
    if evidence == "winner":
        played.winner_entry_id = played.entry_a_id
    else:
        played.match_id = (await _make_match(db_session, owner, default_league)).id
    await db_session.commit()
    before = _snapshot(await _fixture_rows(db_session, event["id"]))

    response = await getattr(client, verb)(_draw_url(tournament_id, event["id"]))

    assert response.status_code == 409, response.text
    assert "already under way" in response.json()["detail"]
    assert _snapshot(await _fixture_rows(db_session, event["id"])) == before


async def test_the_play_guard_is_scoped_to_the_event_being_cut(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """One event's play does not seal another's draw.

    A tournament runs several events at once, and the under-13s starting does not mean
    the open singles' late entrant can no longer be drawn in. A guard that asked "has
    anything in this tournament been played?" would freeze every draw on the day the
    first match started — which is exactly when a director still needs to re-cut around
    the no-shows.
    """
    client, _ = authed_client
    tournament_id, (played_event, other_event) = await _tournament_with_events(
        client,
        _rr_payload(POOL_A, POOL_B, name="Under 13s"),
        _rr_payload(POOL_A, POOL_B, name="Open Singles"),
    )
    await _seed_field(db_session, played_event["id"], 4, prefix="u13-")
    await _seed_field(db_session, other_event["id"], 4, prefix="open-")
    await client.post(_draw_url(tournament_id, played_event["id"]))
    await client.post(_draw_url(tournament_id, other_event["id"]))

    played, *_ = await _fixture_rows(db_session, played_event["id"])
    played.winner_entry_id = played.entry_a_id
    await db_session.commit()

    # The played event is sealed…
    sealed = await client.post(_draw_url(tournament_id, played_event["id"]))
    assert sealed.status_code == 409, sealed.text
    # …and its neighbour is not.
    open_recut = await client.post(_draw_url(tournament_id, other_event["id"]))
    assert open_recut.status_code == 201, open_recut.text


# ----- the row lock behind the cut ------------------------------------------


async def test_both_draw_verbs_take_the_tournaments_row_lock(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    engine: AsyncEngine,
) -> None:
    """A cut reads the event's active field and writes fixtures **derived from it**, so
    it is a judge-then-write path and it takes the tournament's row lock — the same
    lock, on the same row, taken first, that entering, withdrawing, transitioning and
    PATCHing already take (which keeps the five of them free of a deadlock cycle).

    Without it the read and the write sit in different instants (Postgres runs READ
    COMMITTED), and an entry committing between them leaves a persisted draw that never
    matched any real field: a pool sized for four players holding five, or an entrant
    who registered in time and is seated nowhere. Every writer of that field already
    queues on this row; the lock is what puts the cut in the same queue.

    The un-cut takes it too. It reads the play evidence and then deletes what that
    evidence protects — the same judge-then-write shape — and taking the one lock in the
    one order is also what keeps the two draw verbs from racing each other.

    Pinned on the *statement*, as ``test_only_the_mutating_loader_takes_the_row_lock``
    pins the lifecycle's: a lock that quietly stopped being asked for would reopen the
    race in silence, and no assertion about a response body would notice.
    """
    client, owner = authed_client
    tournament_id, (event,) = await _tournament_with_events(
        client, _rr_payload(POOL_A, POOL_B)
    )
    await _seed_field(db_session, event["id"], 4)
    owner_id = owner.id

    async with counted_statements(engine) as (session, statements):
        await cut_event_draw(
            tournament_id=uuid.UUID(tournament_id),
            event_id=uuid.UUID(event["id"]),
            db=session,
            current_user=User(id=owner_id),
        )
    assert any("FOR UPDATE" in s for s in statements), statements

    async with counted_statements(engine) as (session, statements):
        await uncut_event_draw(
            tournament_id=uuid.UUID(tournament_id),
            event_id=uuid.UUID(event["id"]),
            db=session,
            current_user=User(id=owner_id),
        )
    assert any("FOR UPDATE" in s for s in statements), statements


# ----- the pool-set freeze (409) --------------------------------------------
#
# A fixture names its pool by a string ref into the event's own ``pools`` JSONB, and
# there is no pools table to foreign-key (ADR-0786). So the DATABASE cannot refuse the
# edit that orphans a fixture — the event PATCH must, and these are the tests of it.
#
# What freezes once a draw is cut is the pool **id set**, and only that. Everything else
# about a pool — its tables, its window, its name — stays editable with a draw standing,
# because venues move under running tournaments. Both halves are load-bearing: a freeze
# that also froze the tables would force a director to destroy a *correct* draw just to
# record a broken table, which is worse than the bug it was guarding against.

# A third pool, for the payloads that try to grow the event's pool set.
POOL_C: dict[str, Any] = {
    "id": "p-c",
    "name": "Pool C",
    "slot": {"date": "2026-06-13", "start": "13:00", "end": "16:30"},
    "table_ids": ["t3"],
}


async def _pools_of(db_session: AsyncSession, event_id: str) -> list[dict[str, Any]]:
    """The event's ``pools``, read straight from the JSONB column.

    A column-only ``SELECT``, deliberately: it never touches the identity map, so what
    comes back is what the *row* holds and not a stale ORM instance the test session
    happened to be holding from before the request.

    This is what "the refusal changed nothing" has to be asserted against. "The event
    still has pools" would pass against a guard that 409'd *after* writing them.
    """
    pools = (
        await db_session.execute(
            select(TournamentEvent.pools).where(
                TournamentEvent.id == uuid.UUID(event_id)
            )
        )
    ).scalar_one()
    return list(pools)


async def test_a_draw_of_one_fixture_still_freezes_the_pool_set(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """One pool, two players, **one fixture** — the smallest draw there is — freezes the
    pool set exactly as a full one does.

    What the freeze turns on is whether the event has *any* fixtures, and the boundary
    between "any" and "none" is one. Every other freeze test cuts a four-fixture draw,
    so a guard that had drifted to "more than one fixture" — a single character away,
    and the kind of thing a refactor does on the way past — would pass all of them and
    fail only here: the pools would be replaced under the draw, and its one fixture
    would be left pointing at a pool the event no longer has. There is no foreign key
    to catch it.
    (Measured: ``event_has_draw``'s ``count > 0`` mutated to ``count > 1`` survived the
    entire suite. This is the test that kills it.)

    It is not an exotic shape, either — it is a club night with one pool and two players
    who turned up.
    """
    client, _ = authed_client
    tournament_id, (event,) = await _tournament_with_events(client, _rr_payload(POOL_A))
    await _seed_field(db_session, event["id"], 2)
    cut = await client.post(_draw_url(tournament_id, event["id"]))
    assert cut.status_code == 201, cut.text
    fixtures_before = _snapshot(await _fixture_rows(db_session, event["id"]))
    assert len(fixtures_before) == 1

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event['id']}",
        json={"pools": [POOL_B]},
    )

    assert response.status_code == 409, response.text
    assert await _pools_of(db_session, event["id"]) == [POOL_A]
    assert _snapshot(await _fixture_rows(db_session, event["id"])) == fixtures_before


async def _cut_two_pool_event(
    client: AsyncClient, db_session: AsyncSession
) -> tuple[str, dict[str, Any]]:
    """A two-pool round-robin over four players, with its draw **cut** — the state the
    freeze applies in. Four fixtures, two in each pool, every one of them holding a
    ``pool_id`` that resolves against the event's pools."""
    tournament_id, (event,) = await _tournament_with_events(
        client, _rr_payload(POOL_A, POOL_B)
    )
    await _seed_field(db_session, event["id"], 4)
    cut = await client.post(_draw_url(tournament_id, event["id"]))
    assert cut.status_code == 201, cut.text
    return tournament_id, event


@pytest.mark.parametrize(
    ("edit", "description"),
    [
        pytest.param({"table_ids": ["t7", "t8"]}, "a table breaks", id="tables"),
        pytest.param(
            {"slot": {"date": "2026-06-13", "start": "10:30", "end": "14:00"}},
            "the pool runs late",
            id="window",
        ),
        pytest.param({"name": "Morning Pool"}, "the director renames it", id="name"),
    ],
)
async def test_a_cut_draw_still_lets_a_pools_venue_attributes_be_edited(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    edit: dict[str, Any],
    description: str,
) -> None:
    """The case the freeze exists to **permit**. With the draw cut, the director changes
    a pool's tables, its time window, or its name — and the PATCH succeeds.

    This is the whole point of freezing the id *set* rather than the pools: venues
    change under a running tournament. A table breaks and is pulled; another frees up
    early; a pool slips an hour. A director who could not record that without un-cutting
    the draw would have to destroy a draw that is *correct* — losing every placement —
    to move a table, and would simply stop using the app on the day.

    The rename is the subtle one. A name is identity-*adjacent* and it is not identity:
    "Pool A" becoming "Morning Pool" keeps the ``id`` the fixtures actually hold, so
    every one of them still resolves. It is a display change, and it is allowed.

    The fixtures are asserted **untouched** (``_snapshot``, every column of every row)
    and not merely present: an edit that quietly re-cut the draw to "keep it consistent"
    would satisfy a count and would have thrown away the placements anyway.
    """
    client, _ = authed_client
    tournament_id, event = await _cut_two_pool_event(client, db_session)
    before = _snapshot(await _fixture_rows(db_session, event["id"]))
    edited = [{**POOL_A, **edit}, POOL_B]

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event['id']}",
        json={"pools": edited},
    )

    assert response.status_code == 200, response.text
    assert response.json()["pools"] == edited
    assert await _pools_of(db_session, event["id"]) == edited
    assert _snapshot(await _fixture_rows(db_session, event["id"])) == before


@pytest.mark.parametrize(
    ("pools", "named"),
    [
        pytest.param([POOL_A, POOL_B, POOL_C], ["Pool C"], id="added"),
        pytest.param([POOL_A], ["Pool B"], id="removed"),
        pytest.param([], ["Pool A", "Pool B"], id="cleared"),
        pytest.param(
            [POOL_A, {**POOL_B, "id": "p-b2"}], ["Pool B"], id="re-identified"
        ),
    ],
)
async def test_a_cut_draw_refuses_a_pools_patch_that_changes_which_pools_exist(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    pools: list[dict[str, Any]],
    named: list[str],
) -> None:
    """The freeze itself: with a draw standing, a ``pools`` payload must carry exactly
    the pool ids the event already has.

    Each arm is a different way to break the same reference, and none of them is a thing
    the database can refuse (``pool_id`` is a string ref into JSONB, not a foreign key):

    * **added** — the new pool arrives with no fixtures, because the draw was dealt
      across the pools that existed at the cut and nothing re-deals it;
    * **removed** / **cleared** — every fixture drawn into the departing pool now names
      a pool that does not exist;
    * **re-identified** — a pool that keeps its name and changes its ``id`` is *both* of
      the above at once, and it is the one a director would never see coming. The pools
      page looks unchanged; the fixtures are all orphaned.

    409, not 403 (ADR-0017): the caller is the owner and the payload is well-formed — it
    is the event that is in the wrong *state* for it, and the same payload becomes legal
    the moment the draw is removed.

    The refusal must change **nothing**, and both halves of "nothing" are asserted: the
    pools JSONB is the same list of dicts it was (not "still non-empty"), and the
    fixtures are the same rows, column for column. That is not decoration — it was
    measured. A guard that judged the pools correctly but raised *after* the ``setattr``
    loop (leaving the rollback to clean up) was mutated in, and it still 409s: only the
    pools-JSONB assertion reds, because the dirty write is flushed ahead of the read. A
    status-code-only test passes that guard — which would persist the very edit it
    refuses the day somebody added a ``commit`` somewhere convenient.
    """
    client, _ = authed_client
    tournament_id, event = await _cut_two_pool_event(client, db_session)
    fixtures_before = _snapshot(await _fixture_rows(db_session, event["id"]))
    pools_before = await _pools_of(db_session, event["id"])
    assert pools_before == [POOL_A, POOL_B]

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event['id']}",
        json={"pools": pools},
    )

    assert response.status_code == 409, response.text
    # The copy names the pools that are in the way, by NAME: a director reads names, and
    # "the pool set is frozen" without saying which pool moved is unactionable.
    detail = response.json()["detail"]
    for name in named:
        assert name in detail, detail
    assert await _pools_of(db_session, event["id"]) == pools_before
    assert _snapshot(await _fixture_rows(db_session, event["id"])) == fixtures_before


async def test_a_refused_pools_patch_writes_none_of_the_rest_of_the_payload_either(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """The refusal is total, not partial: a PATCH that renames the event *and* removes a
    pool changes neither.

    The event's other fields are not innocent bystanders that may as well land — the
    payload is one request and it is refused as one. This is the test that fails against
    a guard placed *after* the ``setattr`` loop and rescued only by the rollback, and
    against one that checked the pools while letting the rest through.
    """
    client, _ = authed_client
    tournament_id, event = await _cut_two_pool_event(client, db_session)

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event['id']}",
        json={"name": "Renamed Event", "pools": [POOL_A]},
    )

    assert response.status_code == 409, response.text
    (name,) = (
        (
            await db_session.execute(
                select(TournamentEvent.name).where(
                    TournamentEvent.id == uuid.UUID(event["id"])
                )
            )
        )
        .scalars()
        .all()
    )
    assert name == event["name"]
    assert await _pools_of(db_session, event["id"]) == [POOL_A, POOL_B]


async def test_an_event_with_no_draw_replaces_its_pools_wholesale(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """No draw, no freeze: the pools of an un-drawn event are configuration, and they
    replace wholesale exactly as they always have.

    The pools are swapped for an entirely different set — different ids, different count
    — which is the payload the freeze refuses on a cut event. There are no fixtures to
    orphan, so there is nothing to refuse, and a guard that fired on the *pools* rather
    than on the *draw* would break every director who is still setting the event up.
    """
    client, _ = authed_client
    tournament_id, (event,) = await _tournament_with_events(
        client, _rr_payload(POOL_A, POOL_B)
    )

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event['id']}",
        json={"pools": [POOL_C]},
    )

    assert response.status_code == 200, response.text
    assert await _pools_of(db_session, event["id"]) == [POOL_C]


async def test_removing_the_draw_un_freezes_the_pool_set(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """The way out, end to end: the PATCH the freeze refused is the PATCH that succeeds
    once the draw is gone.

    ``DELETE …/draw`` un-freezes the pool set — by construction, since the freeze is a
    fact about the fixtures existing — and that is what makes the 409 a *conflict*
    rather than a prohibition: the director has somewhere to go. The refusal's own copy
    tells them to come this way, so the path it names had better work.
    """
    client, _ = authed_client
    tournament_id, event = await _cut_two_pool_event(client, db_session)
    url = f"/v1/tournaments/{tournament_id}/events/{event['id']}"
    repooled = [POOL_A, POOL_B, POOL_C]

    refused = await client.patch(url, json={"pools": repooled})
    assert refused.status_code == 409, refused.text

    uncut = await client.delete(_draw_url(tournament_id, event["id"]))
    assert uncut.status_code == 204, uncut.text

    accepted = await client.patch(url, json={"pools": repooled})

    assert accepted.status_code == 200, accepted.text
    assert await _pools_of(db_session, event["id"]) == repooled
    assert await _fixture_rows(db_session, event["id"]) == []


async def test_a_patch_that_does_not_send_pools_is_untouched_by_the_freeze(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """A cut draw does not freeze the *event* — only its set of pools.

    The director may still rename the event, move its entry fee, tighten its rules. A
    guard that fired on any PATCH of an event with a draw (rather than on a ``pools``
    payload that changes the id set) would pass every test above and would lock the
    whole event on the day it was drawn.
    """
    client, _ = authed_client
    tournament_id, event = await _cut_two_pool_event(client, db_session)
    before = _snapshot(await _fixture_rows(db_session, event["id"]))

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event['id']}",
        json={"name": "Open Singles (redrawn)"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["name"] == "Open Singles (redrawn)"
    assert await _pools_of(db_session, event["id"]) == [POOL_A, POOL_B]
    assert _snapshot(await _fixture_rows(db_session, event["id"])) == before


async def test_the_pool_freeze_is_scoped_to_the_event_being_patched(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """One event's draw does not freeze another event's pools.

    A tournament runs several events at once and they are drawn on different days. The
    under-13s being drawn must not stop the director from still building the open
    singles' pools — which is what a guard that asked "does this *tournament* have any
    fixtures?" would do.
    """
    client, _ = authed_client
    tournament_id, (drawn, undrawn) = await _tournament_with_events(
        client,
        _rr_payload(POOL_A, POOL_B, name="Under 13s"),
        _rr_payload(POOL_A, POOL_B, name="Open Singles"),
    )
    await _seed_field(db_session, drawn["id"], 4, prefix="u13-")
    await client.post(_draw_url(tournament_id, drawn["id"]))

    # The drawn event's pool set is frozen…
    sealed = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{drawn['id']}",
        json={"pools": [POOL_A, POOL_B, POOL_C]},
    )
    assert sealed.status_code == 409, sealed.text
    # …and its neighbour's, which has no draw, is not.
    free = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{undrawn['id']}",
        json={"pools": [POOL_C]},
    )
    assert free.status_code == 200, free.text
    assert await _pools_of(db_session, undrawn["id"]) == [POOL_C]


async def test_the_event_patch_takes_the_tournaments_row_lock(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    engine: AsyncEngine,
) -> None:
    """The event PATCH is a judge-then-write path now, so it takes the tournament's row
    lock — the same lock, on the same row, taken first, that the draw verbs, the
    transition, the entry and the withdrawal take (which is what keeps them free of a
    deadlock cycle).

    The freeze reads whether a draw exists and then writes the pools that draw's
    fixtures refer to. Postgres runs READ COMMITTED, so without the lock those two sit
    in different instants: a cut committing between them is a draw cut across pools this
    request is in the middle of replacing — fixtures orphaned at birth, refused by
    nothing, and neither request wrong on its own.

    Pinned on the *statement*, like ``test_only_the_mutating_loader_takes_the_row_lock``
    and ``test_both_draw_verbs_take_the_tournaments_row_lock``: a lock that quietly
    stopped being taken would reopen the race in silence, and no assertion about a
    response body would notice.
    """
    client, owner = authed_client
    tournament_id, event = await _cut_two_pool_event(client, db_session)
    owner_id = owner.id

    async with counted_statements(engine) as (session, statements):
        await update_event(
            tournament_id=uuid.UUID(tournament_id),
            event_id=uuid.UUID(event["id"]),
            payload=TournamentEventUpdate(name="Open Singles (moved)"),
            db=session,
            current_user=User(id=owner_id),
        )
    assert any("FOR UPDATE" in s for s in statements), statements


# ----- a pool id identifies one pool (422) -----------------------------------
#
# The freeze above protects the pool ids a draw was cut across. It rests on an
# assumption nothing enforced: that an id names ONE pool. Pools are JSONB with
# client-supplied string ids — there is no pools table, so no unique index — and an
# event with two pools called ``p-a`` was stored verbatim (measured: 201). The bill
# arrived at the cut, which deals the field across the event's pool ids: two pools with
# one id deal onto the same ``(event_id, pool_id, round, position)``, and the fixture
# table's unique constraint answers the director with a **500**.
#
# Worse, the freeze itself let the poison in by PATCH, because it compares SETS:
# ``[A, A, B]`` against a cut event holding ``{A, B}`` is the same set, so the guard
# that exists to protect the draw waved through the payload that breaks it (measured:
# 200, then the next cut 500'd). So the rule lives at the BOUNDARY — one validator on
# the ``pools`` list type both write schemas share, covering create and patch in one
# place, in every state the event can be in.


def _pools_error(response: Response) -> str:
    """The 422's message for the ``pools`` field, as one string.

    A pydantic 422 is a *list* of errors keyed by ``loc``; the copy the director reads
    is the ``msg``. Reading it out of the right ``loc`` is what stops this test from
    passing on some *other* field's refusal.
    """
    errors = response.json()["detail"]
    return " ".join(
        error["msg"] for error in errors if error["loc"][:2] == ["body", "pools"]
    )


@pytest.mark.parametrize(
    ("pools", "named"),
    [
        pytest.param([POOL_A, POOL_A], ["p-a"], id="the-same-pool-twice"),
        pytest.param([POOL_A, {**POOL_B, "id": "p-a"}], ["p-a"], id="two-pools-one-id"),
        pytest.param(
            [POOL_A, POOL_A, POOL_B, POOL_B], ["p-a", "p-b"], id="two-ids-duplicated"
        ),
    ],
)
async def test_creating_an_event_with_duplicate_pool_ids_is_refused(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    pools: list[dict[str, Any]],
    named: list[str],
) -> None:
    """An event cannot be **born** holding two pools with the same id.

    ``two-pools-one-id`` is the arm that matters: two genuinely different pools
    (different names, different tables, different windows) that happen to share an
    ``id``. The pools page looks perfectly sane, and the draw is undrawable. Duplicating
    a whole pool is the same fault with an easier tell.

    The refusal names the duplicated **id**, not a pool name: an id is what is
    duplicated, the two pools sharing it may be named anything, and the id is the thing
    the director has to go and change.

    422, not 409 — this is a malformed payload in *every* state the event could be in.
    An event with no draw at all still cannot have two pools called ``p-a``; there is no
    later moment at which this body becomes legal, which is exactly what separates it
    from the pool-set freeze's conflict.

    And the refusal creates **nothing**: a 422 that had already written the event would
    be a 422 in name only.
    """
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()

    response = await client.post(
        f"/v1/tournaments/{created['id']}/events", json=_rr_payload(*pools)
    )

    assert response.status_code == 422, response.text
    message = _pools_error(response)
    for pool_id in named:
        assert f"“{pool_id}”" in message, message
    assert await _events_of(client, created["id"]) == []


async def test_a_pools_patch_that_duplicates_an_id_never_reaches_the_cut_draw(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """**The discriminating case**, and the one the set-based freeze cannot see.

    ``[A, A, B]`` against a cut event holding ``{A, B}`` is, as a *set*, exactly the
    pools the event already has. ``_enforce_pool_set_frozen`` compares sets — because
    identity is all it is about — so it finds nothing removed and nothing added, and it
    waved this payload through: measured **200**, the duplicate stored verbatim, and the
    *next* cut dead on ``uq_tournament_fixtures_event_id_pool_id_round_position`` (a
    **500**). The guard that exists to protect the draw was admitting the payload that
    poisons it.

    A boundary rule is what closes it, because the freeze is the wrong instrument: it
    can only ever compare which pools exist, and this payload does not change that.

    The proof is not the status code. It is the **re-cut afterwards**: the same event,
    cut again, still answers 201. A guard that 409'd or 422'd and *wrote the pools
    anyway* would satisfy every assertion about the response and still hand the director
    the 500 the moment they cut — so the cut is where this test looks.
    """
    client, _ = authed_client
    tournament_id, event = await _cut_two_pool_event(client, db_session)
    fixtures_before = _snapshot(await _fixture_rows(db_session, event["id"]))

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event['id']}",
        json={"pools": [POOL_A, POOL_A, POOL_B]},
    )

    assert response.status_code == 422, response.text
    assert "“p-a”" in _pools_error(response)
    # Nothing written: the pools are the two they were, and the fixtures are the same
    # rows, column for column.
    assert await _pools_of(db_session, event["id"]) == [POOL_A, POOL_B]
    assert _snapshot(await _fixture_rows(db_session, event["id"])) == fixtures_before
    # And the cut the duplicate would have detonated still works.
    re_cut = await client.post(_draw_url(tournament_id, event["id"]))
    assert re_cut.status_code == 201, re_cut.text


async def test_an_undrawn_event_also_refuses_a_pools_patch_that_duplicates_an_id(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """The rule is the **boundary's**, not the freeze's: an event with no draw at all —
    where the pool set is not frozen and pools replace wholesale — still cannot be given
    two pools with one id.

    A guard implemented inside ``_enforce_pool_set_frozen`` would pass the test above
    and fail this one, leaving every un-drawn event free to store the duplicate and 500
    on its first cut. The event is not yet drawn, and the pools it will be drawn across
    are already nonsense.
    """
    client, _ = authed_client
    tournament_id, (event,) = await _tournament_with_events(
        client, _rr_payload(POOL_A, POOL_B)
    )

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event['id']}",
        json={"pools": [POOL_C, POOL_C]},
    )

    assert response.status_code == 422, response.text
    assert "“p-c”" in _pools_error(response)
    assert await _pools_of(db_session, event["id"]) == [POOL_A, POOL_B]


# ----- an id is not the empty string (422) -----------------------------------
#
# The rule above says an id names ONE pool. This one says an id is a *thing*:
# ``Pool.id`` was a bare ``str``, so ``Pool(id="")`` validated, and an event could be
# created and patched holding a pool with no id at all (measured: 201).
#
# An empty pool id is not a cosmetic defect, because a fixture names its pool by that
# string (ADR-0786) and the domain asks two questions of the ref that DISAGREE about
# ``""``. In ``app.draws.ready_fixtures``: "is this fixture pooled?" is ``pool_id is
# None`` — and ``""`` is not ``None``, so *yes, pooled* — while the sort key that orders
# the plan reads ``pool_id or ""``, where the empty id collapses onto the value the
# UN-pooled fixtures sort under. One fixture, pooled by one rule and un-pooled by the
# other, and a draw whose order depends on which of the two you asked.
#
# The fix is not a runtime check downstream, and not a defensive ``if not pool_id`` in
# the sort: it is a floor on the type at the write boundary (``ValueObjectId``,
# ``min_length=1``), so the state never exists to be reasoned about (api/CLAUDE.md,
# "make illegal states unrepresentable"). Like every other rule about a pools payload it
# holds on **both verbs** — an event that could not be born with an empty pool id but
# could be *edited* into one is an event that can hold it.


def _error_locs(response: Response) -> list[list[Any]]:
    """Every ``loc`` a pydantic 422 named, as lists.

    The refusal must be attributed to the FIELD, not merely to the request: a client
    renders a validation error under the input that caused it, and a 422 that pointed at
    ``body`` alone would leave the organizer hunting a blank box.
    """
    return [error["loc"] for error in response.json()["detail"]]


@pytest.mark.parametrize(
    ("pool", "field"),
    [
        pytest.param({**POOL_A, "id": ""}, "id", id="empty-id"),
        pytest.param({**POOL_A, "name": ""}, "name", id="empty-name"),
    ],
)
async def test_creating_an_event_with_an_empty_pool_id_or_name_is_refused(
    authed_client: tuple[AsyncClient, User],
    pool: dict[str, Any],
    field: str,
) -> None:
    """An event cannot be **born** with a pool whose id — or whose name — is ``""``.

    The id is the one with teeth (see the section comment: a fixture drawn into ``""``
    is pooled and un-pooled at the same time). The name is refused for the plainer
    reason that a pool is *called* something: it is what the director clicks, what the
    double-booking warning quotes and what a player reads off a wall, and a list of
    three blank rows is not a thing anyone can act on.

    And the refusal writes nothing: a 422 that had already stored the event would be a
    422 in name only.
    """
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()

    response = await client.post(
        f"/v1/tournaments/{created['id']}/events", json=_rr_payload(pool, POOL_B)
    )

    assert response.status_code == 422, response.text
    assert ["body", "pools", 0, field] in _error_locs(response), response.text
    assert await _events_of(client, created["id"]) == []


@pytest.mark.parametrize(
    ("pool", "field"),
    [
        pytest.param({**POOL_C, "id": ""}, "id", id="empty-id"),
        pytest.param({**POOL_C, "name": ""}, "name", id="empty-name"),
    ],
)
async def test_a_pools_patch_that_empties_a_pool_id_or_name_is_refused(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    pool: dict[str, Any],
    field: str,
) -> None:
    """The **other verb**, and the one that would otherwise be the hole: an event born
    with two perfectly good pools, edited into holding one with no id.

    Deliberately an **un-drawn** event, where the pool-set freeze does not apply at
    all. On a *cut* event this payload changes the pool set (``{"", p-b}`` is not
    ``{p-a, p-b}``), so the freeze would 409 it and the test would pass without the
    boundary rule existing — proving nothing about the boundary. Here there is no draw
    and no freeze:
    pools replace wholesale, and the only thing between the column and ``""`` is the
    schema.
    """
    client, _ = authed_client
    tournament_id, (event,) = await _tournament_with_events(
        client, _rr_payload(POOL_A, POOL_B)
    )

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event['id']}",
        json={"pools": [pool]},
    )

    assert response.status_code == 422, response.text
    assert ["body", "pools", 0, field] in _error_locs(response), response.text
    assert await _pools_of(db_session, event["id"]) == [POOL_A, POOL_B]


async def test_creating_a_tournament_with_an_empty_table_id_is_refused(
    authed_client: tuple[AsyncClient, User],
) -> None:
    """A table in the venue catalogue is the same string-ref pattern as a pool: a pool
    holds a list of these ids (``table_ids``) and nothing else connects the two — no
    table, no foreign key, no index. An id of ``""`` is a table nothing can name, and a
    ``table_ids`` entry of ``""`` would "resolve" against it.

    Closing the hole on pools and leaving it open on the thing pools point AT would be a
    boundary drawn half way.
    """
    client, _ = authed_client

    response = await client.post(
        "/v1/tournaments",
        json=_create_payload(
            table_catalogue=[{"id": "", "label": "Table 1", "court": "A"}]
        ),
    )

    assert response.status_code == 422, response.text
    assert ["body", "table_catalogue", 0, "id"] in _error_locs(response), response.text


async def test_patching_a_table_catalogue_with_an_empty_table_id_is_refused(
    authed_client: tuple[AsyncClient, User],
) -> None:
    """The table catalogue's patch verb, for the reason every pools rule is stated
    on both verbs: a tournament that could not be created with an id-less table and
    could be edited into one is a tournament that holds an id-less table."""
    client, _ = authed_client
    created = (await client.post("/v1/tournaments", json=_create_payload())).json()

    response = await client.patch(
        f"/v1/tournaments/{created['id']}",
        json={"table_catalogue": [{"id": "", "label": "Table 9", "court": "B"}]},
    )

    assert response.status_code == 422, response.text
    assert ["body", "table_catalogue", 0, "id"] in _error_locs(response), response.text
    # And the catalogue it was born with is the catalogue it still has.
    reread = (await client.get(f"/v1/tournaments/{created['id']}")).json()
    assert [table["id"] for table in reread["table_catalogue"]] == ["t1", "t2"]


# ----- the draw-type freeze (409) -------------------------------------------
#
# A draw type is not a label on an event: it is the strategy that DEALT the event's
# fixtures, and the fixtures are the shape that strategy prescribes. Patch it under a
# standing draw and the event contradicts itself — a ``single-elim`` event holding
# pooled round-robin fixtures (measured: the PATCH answered 200) — and nothing
# downstream catches it, because the go-live currency check compares the ENTRANT SET the
# fixtures seat, which a re-label does not move. So the corrupted event reads as
# ``current`` and starts.
#
# Same doctrine as the pool-set freeze, one field over: what a cut draw freezes is the
# facts its fixtures were derived from.


async def _draw_type_of(db_session: AsyncSession, event_id: str) -> DrawType:
    """The event's ``draw_type``, read straight from the column — never from a response
    body, and never from an ORM instance the test session may be holding stale."""
    return (
        await db_session.execute(
            select(TournamentEvent.draw_type).where(
                TournamentEvent.id == uuid.UUID(event_id)
            )
        )
    ).scalar_one()


async def test_a_cut_draw_freezes_the_draw_type(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """The freeze itself: with a draw standing, the draw type cannot be changed.

    409, not 403 (ADR-0017): the caller is the owner and the payload is well-formed — it
    is the *event* that is in the wrong state, and the same request becomes legal the
    moment the draw is removed. That is what the refusal's copy tells them to do, and it
    is not decoration: today ``single-elim`` has no strategy, so an event patched into
    it while holding round-robin fixtures cannot even be re-cut back into agreement with
    itself (the re-cut 422s), and the director is stuck guessing which draw type to
    patch it *back* to.

    The refusal must change **nothing**, and both halves are asserted from the database:
    the stored ``draw_type`` and every column of every fixture. A status-code-only
    assertion would pass a guard that wrote the value and let the rollback clean up —
    which persists the very edit it refuses the day somebody adds a convenient
    ``commit``.
    """
    client, _ = authed_client
    tournament_id, event = await _cut_two_pool_event(client, db_session)
    fixtures_before = _snapshot(await _fixture_rows(db_session, event["id"]))

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event['id']}",
        json={"draw_type": "single-elim"},
    )

    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert "“round-robin”" in detail, detail
    assert "remove the draw" in detail, detail
    assert await _draw_type_of(db_session, event["id"]) is DrawType.round_robin
    assert _snapshot(await _fixture_rows(db_session, event["id"])) == fixtures_before


async def test_a_refused_draw_type_patch_writes_none_of_the_rest_of_the_payload_either(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """The refusal is total: a PATCH that renames the event *and* re-types its draw
    changes neither.

    The payload is one request and it is refused as one. This is the test that fails
    against a guard placed *after* the ``setattr`` loop and rescued only by the
    rollback.
    """
    client, _ = authed_client
    tournament_id, event = await _cut_two_pool_event(client, db_session)

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event['id']}",
        json={"name": "Renamed Event", "draw_type": "single-elim"},
    )

    assert response.status_code == 409, response.text
    stored = (
        await db_session.execute(
            select(TournamentEvent.name, TournamentEvent.draw_type).where(
                TournamentEvent.id == uuid.UUID(event["id"])
            )
        )
    ).one()
    assert stored == (event["name"], DrawType.round_robin)


async def test_an_undrawn_event_still_changes_its_draw_type(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """No draw, no freeze. An event nobody has cut yet is *configuration*, and its draw
    type is the most ordinary thing about it for a director to still be deciding.

    A guard that fired on the field rather than on the draw would lock the draw type at
    creation — and there would be no way to change it at all, since there are no
    fixtures to remove.
    """
    client, _ = authed_client
    tournament_id, (event,) = await _tournament_with_events(
        client, _rr_payload(POOL_A, POOL_B)
    )

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event['id']}",
        json={"draw_type": "single-elim"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["draw_type"] == "single-elim"
    assert await _draw_type_of(db_session, event["id"]) is DrawType.single_elim


async def test_re_sending_the_same_draw_type_with_a_venue_edit_still_succeeds(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """**Presence is not the rule — the change is.** A PATCH that carries the draw type
    the event *already has*, alongside a legitimate venue edit, succeeds.

    This is the case a guard written as "``draw_type`` in the payload and a draw exists
    → 409" would break, and it is not exotic: a client that PATCHes the whole event form
    back sends every field it rendered, draw type included. Refusing it would make the
    pool-venue edit — the very thing the freeze above exists to *permit* — unreachable
    from that page, and a table that broke on the morning of the tournament would cost
    the director their draw.

    Re-asserting a value that is already there changes nothing, so it is not a conflict.
    (It differs from the league freeze, which *does* refuse the value it already holds:
    that field is settled by a status no request of the caller's can move, so the only
    client that sends it is a stale one. Here the way out — remove the draw — is on the
    caller's own keyboard.)
    """
    client, _ = authed_client
    tournament_id, event = await _cut_two_pool_event(client, db_session)
    fixtures_before = _snapshot(await _fixture_rows(db_session, event["id"]))
    moved = [{**POOL_A, "table_ids": ["t7"]}, POOL_B]

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event['id']}",
        json={"draw_type": "round-robin", "pools": moved},
    )

    assert response.status_code == 200, response.text
    assert response.json()["draw_type"] == "round-robin"
    assert await _draw_type_of(db_session, event["id"]) is DrawType.round_robin
    assert await _pools_of(db_session, event["id"]) == moved
    assert _snapshot(await _fixture_rows(db_session, event["id"])) == fixtures_before


async def test_removing_the_draw_un_freezes_the_draw_type(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """The way out, end to end: the PATCH the freeze refused is the PATCH that succeeds
    once the draw is gone.

    That is what makes the 409 a *conflict* rather than a prohibition — the director has
    somewhere to go, and the refusal's own copy sends them this way, so the path it
    names had better work.
    """
    client, _ = authed_client
    tournament_id, event = await _cut_two_pool_event(client, db_session)
    url = f"/v1/tournaments/{tournament_id}/events/{event['id']}"

    refused = await client.patch(url, json={"draw_type": "single-elim"})
    assert refused.status_code == 409, refused.text

    uncut = await client.delete(_draw_url(tournament_id, event["id"]))
    assert uncut.status_code == 204, uncut.text

    accepted = await client.patch(url, json={"draw_type": "single-elim"})

    assert accepted.status_code == 200, accepted.text
    assert await _draw_type_of(db_session, event["id"]) is DrawType.single_elim
    assert await _fixture_rows(db_session, event["id"]) == []


async def test_the_draw_type_freeze_is_scoped_to_the_event_being_patched(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """One event's draw does not freeze another event's draw type.

    The under-13s being drawn must not stop the director from still deciding how the
    open singles will be run — which is what a guard that asked "does this *tournament*
    have any fixtures?" would do.
    """
    client, _ = authed_client
    tournament_id, (drawn, undrawn) = await _tournament_with_events(
        client,
        _rr_payload(POOL_A, POOL_B, name="Under 13s"),
        _rr_payload(POOL_A, POOL_B, name="Open Singles"),
    )
    await _seed_field(db_session, drawn["id"], 4, prefix="u13-")
    await _cut_the_draw(client, tournament_id, drawn["id"])

    sealed = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{drawn['id']}",
        json={"draw_type": "single-elim"},
    )
    assert sealed.status_code == 409, sealed.text

    free = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{undrawn['id']}",
        json={"draw_type": "single-elim"},
    )

    assert free.status_code == 200, free.text
    assert await _draw_type_of(db_session, undrawn["id"]) is DrawType.single_elim
    assert await _draw_type_of(db_session, drawn["id"]) is DrawType.round_robin
