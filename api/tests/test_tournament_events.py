"""Service-layer tests for the transport-neutral tournament-event verbs.

These drive ``app.tournament_events.create_event`` / ``delete_event`` directly with
a raw ``db_session`` and no FastAPI — proving each write path (the owner-load, the
create, the delete) runs, persists, and signals every refusal with a **domain
exception** from ``app.tournament_errors`` rather than an ``HTTPException``. The HTTP
wire contract those exceptions map back to is pinned by the unchanged endpoint tests
in ``test_tournaments.py``; this file is the branch matrix behind them.

The delete verb carries NO drawn/live refusal — the delete route never had one — so
the matrix is exactly: create (owned / non-owned / missing-tournament) and delete
(owned / non-owned / missing-tournament / missing-event / cross-tournament mismatch).
"""

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from pydantic import BaseModel, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    DrawType,
    EventFormat,
    League,
    Tournament,
    TournamentEvent,
    TournamentEventDrawSettings,
    TournamentFixture,
    TournamentStatus,
    User,
)
from app.schemas.tournament import Address, TournamentEventCreate, TournamentEventUpdate
from app.tournament_errors import (
    DrawTypeFrozenError,
    EventNotFoundError,
    NotTournamentOwnerError,
    PoolSetFrozenError,
    TournamentNotFoundError,
)
from app.tournament_events import create_event, delete_event, update_event
from tests._helpers import (
    make_user,
    venue_tables,
)


def _address() -> Address:
    # The stored/read shape: it seeds a ``Tournament`` row's JSONB address, which
    # carries the NOT NULL geocoded coordinates.
    return Address(
        venue="Berkeley TT Club",
        street="2727 Milvia St",
        city="Berkeley",
        region="CA",
        postal="94703",
        country="USA",
        latitude=37.8703,
        longitude=-122.2731,
    )


def _event_body(**overrides: Any) -> dict[str, Any]:
    """A valid create-event body as **JSON**, before any parse.

    Split out of :func:`_event_payload` because a refusal test needs the body the client
    would send, not the model — a payload the schema rejects is one ``_event_payload``
    cannot return."""
    body: dict[str, Any] = {
        "name": "Open Singles",
        "format": "singles",
        "draw_type": "single-elim",
        "max_players": 64,
        "entry_fee": 45,
        "timezone": "America/Chicago",
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
    body.update(overrides)
    return body


def _event_payload(**overrides: Any) -> TournamentEventCreate:
    """A valid create-event body (same shape as ``test_tournaments._event_payload``),
    parsed through the same ``TournamentEventCreate`` schema the HTTP route uses."""
    return TournamentEventCreate.model_validate(_event_body(**overrides))


async def _make_tournament(
    db: AsyncSession, *, owner: User, league: League
) -> Tournament:
    tournament = Tournament(
        name="Eventful Cup",
        address=_address().model_dump(),
        tables=venue_tables(("Table 1", "A"), ("Table 2", "A")),
        league_id=league.id,
        created_by_user_id=owner.id,
        status=TournamentStatus.draft,
    )
    db.add(tournament)
    await db.commit()
    await db.refresh(tournament)
    return tournament


async def _add_event(db: AsyncSession, tournament: Tournament) -> TournamentEvent:
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Existing Singles",
        format=EventFormat.singles,
        draw_settings=TournamentEventDrawSettings.for_draw_type(DrawType.round_robin),
        max_players=None,
        entry_fee=Decimal("0.00"),
        timezone="America/Chicago",
        slot={"date": "2026-06-13", "start": "09:00", "end": "17:00"},
        match_settings={"rated": False, "length_games": 3},
        predicates=[],
        pools=[],
    )
    db.add(event)
    await db.commit()
    await db.refresh(event)
    return event


# ----- create --------------------------------------------------------------


async def test_create_persists_an_event_on_an_owned_tournament(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    owner = await make_user(db_session, "events-create-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id

    event, league_id = await create_event(
        db_session,
        tournament_id=tournament_id,
        actor=owner,
        payload=_event_payload(),
    )

    # The verb returns the tournament's league_id (the ladder its events are judged on)
    # beside the event, so the adapter need not re-query the column it just loaded.
    assert league_id == default_league.id
    assert event.tournament_id == tournament_id
    assert event.name == "Open Singles"
    # The nested value-objects persisted as plain JSONB.
    assert event.slot == {"date": "2026-06-13", "start": "09:00", "end": "18:00"}
    assert event.pools[0]["id"] == "p-os-1"
    event_id = event.id

    # Persisted, not merely returned.
    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == event_id)
        )
    ).scalar_one()
    assert row.tournament_id == tournament_id
    assert row.match_settings == {"rated": True, "length_games": 5}


async def test_create_on_a_non_owned_tournament_raises_not_owner(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    owner = await make_user(db_session, "events-create-guard-owner")
    stranger = await make_user(db_session, "events-create-stranger")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id

    with pytest.raises(NotTournamentOwnerError):
        await create_event(
            db_session,
            tournament_id=tournament_id,
            actor=stranger,
            payload=_event_payload(),
        )

    # Nothing was created.
    db_session.expire_all()
    assert (
        await db_session.execute(
            select(TournamentEvent).where(
                TournamentEvent.tournament_id == tournament_id
            )
        )
    ).scalar_one_or_none() is None


async def test_create_on_a_missing_tournament_raises_not_found(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """404 is judged before 403: a missing tournament raises not-found, so a non-owner
    never learns whether an absent id existed."""
    actor = await make_user(db_session, "events-create-missing")

    with pytest.raises(TournamentNotFoundError):
        await create_event(
            db_session,
            tournament_id=uuid.uuid4(),
            actor=actor,
            payload=_event_payload(),
        )


# ----- pool positions ------------------------------------------------------
#
# A pool's ``position`` is the one field on it the client cannot author: it is not on
# the write shape at all (``PoolWrite``), and the server stamps it from the pool's index
# in the list that was sent — on BOTH verbs (ADR 20260801, "Pools carry an explicit
# ``position``"). So there are two claims here, and they need each other:
#
#   * a payload that CARRIES a position is refused, naming the unknown field, rather
#     than having it silently overwritten. "Server-assigned" is then a property of the
#     schema, which a client can read, instead of a sentence in a docstring, which it
#     cannot; and
#   * a payload that does not is stored in the *order sent*, and nothing else. Every
#     pool below is named and id'd so that alphabetical order (by either) is a DIFFERENT
#     answer from the order sent, which is what makes these able to fail — asserting
#     "each pool has a position" would pass against an implementation that assigned all
#     zeros or sorted by name.


def _pool(pool_id: str, name: str, **extra: Any) -> dict[str, Any]:
    """One pool payload, valid but for whatever ``extra`` the caller adds."""
    return {
        "id": pool_id,
        "name": name,
        "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
        "table_ids": ["t1"],
        **extra,
    }


def _named_positions(event: TournamentEvent) -> list[tuple[str, int]]:
    """``(name, position)`` per stored pool, read off the JSONB in **column order**.

    Names, not ids, because a pool named "Pool C" sitting at position 0 is the whole
    claim: it is the pool the director put first, and it is not the alphabetically first
    one. Read from the raw column rather than through ``Pool`` so a default the schema
    supplies could not stand in for a value the write path failed to store.
    """
    return [(pool["name"], pool["position"]) for pool in event.pools]


async def test_create_positions_pools_by_the_order_they_were_sent(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """Three pools sent as **C, A, B** are stored as positions 0, 1, 2 *in that order*.

    Sorted by name — or by id, which is how pool order used to be recovered — the
    answer would be C=2, A=0, B=1. Sorted by nothing at all it would be three zeros.
    The event's pool order is the order the director sent, and this is the assertion
    that distinguishes the three.
    """
    owner = await make_user(db_session, "events-create-pool-positions")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)

    event, _ = await create_event(
        db_session,
        tournament_id=tournament.id,
        actor=owner,
        payload=_event_payload(
            pools=[
                _pool("p-c", "Pool C"),
                _pool("p-a", "Pool A"),
                _pool("p-b", "Pool B"),
            ]
        ),
    )
    event_id = event.id

    assert _named_positions(event) == [("Pool C", 0), ("Pool A", 1), ("Pool B", 2)]

    # Persisted, not merely returned — and read back off the row.
    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == event_id)
        )
    ).scalar_one()
    assert _named_positions(row) == [("Pool C", 0), ("Pool A", 1), ("Pool B", 2)]
    # No two pools of one event share a position.
    positions = [pool["position"] for pool in row.pools]
    assert len(set(positions)) == len(positions)


_POOLS_CLAIMING_A_POSITION = [
    _pool("p-c", "Pool C", position=7),
    _pool("p-a", "Pool A", position=7),
    _pool("p-b", "Pool B", position=7),
]
"""Three pools that each claim position ``7`` — the payload a client writes when it
mistakes a server-assigned field for one of its own."""


@pytest.mark.parametrize(
    ("schema", "body"),
    [
        pytest.param(
            TournamentEventCreate,
            _event_body(pools=_POOLS_CLAIMING_A_POSITION),
            id="create",
        ),
        pytest.param(
            TournamentEventUpdate,
            {"pools": _POOLS_CLAIMING_A_POSITION},
            id="patch",
        ),
    ],
)
def test_a_write_payload_carrying_a_pool_position_is_refused(
    schema: type[BaseModel], body: dict[str, Any]
) -> None:
    """A ``position`` on a pool a client **sends** is an unknown field, on both verbs —
    refused by name, not accepted and quietly overwritten.

    ``position`` is not on ``PoolWrite``, and both write schemas are
    ``extra="forbid"``, so this is the boundary saying "server-assigned" in the one
    register a client can actually read: the field is unsendable, so a client cannot
    believe it decided the order. The alternative — take it and ignore it — is the
    ``entered`` mistake in a different key: a value the caller watched itself send and
    the server watched itself discard, discoverable only in prose.

    Both verbs, because "the patch path is the hole" is this repo's recurring bug: the
    event editor PATCHes the whole form back, so the patch is the verb that would
    actually carry an echoed position. They share one alias (``EventPools``) over one
    pool shape, which is what makes that impossible to get wrong on only one of them.

    The **loc** is asserted, not just the refusal: a 422 that named ``pools`` and
    nothing more would leave a client hunting through its own payload for a field it
    was never told about.
    """
    with pytest.raises(ValidationError) as refusal:
        schema.model_validate(body)

    errors = refusal.value.errors()
    # Every pool that claimed one is named — not merely the first — so the director's
    # client can strip the field everywhere it put it, in one round trip.
    assert [error["loc"] for error in errors] == [
        ("pools", 0, "position"),
        ("pools", 1, "position"),
        ("pools", 2, "position"),
    ]
    assert {error["type"] for error in errors} == {"extra_forbidden"}


async def test_update_repositions_pools_by_the_order_they_were_patched(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The patch path is the other half of the same rule: the event is born C, A, B and
    patched to B, C, A, and its stored positions follow the payload.

    Guarding only ``create`` would leave the order to rot on the first edit — an event
    born with positions and then patched without them would silently fall back to
    whatever the ids happened to sort as, which is the exact failure the explicit
    position exists to end. The event is deliberately **un-drawn**, so the pool-set
    freeze is not what is being tested here: the same three ids go in, re-ordered.
    """
    owner = await make_user(db_session, "events-update-pool-positions")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event, _ = await create_event(
        db_session,
        tournament_id=tournament.id,
        actor=owner,
        payload=_event_payload(
            pools=[
                _pool("p-c", "Pool C"),
                _pool("p-a", "Pool A"),
                _pool("p-b", "Pool B"),
            ]
        ),
    )
    event_id = event.id

    updated, _ = await update_event(
        db_session,
        tournament_id=tournament.id,
        event_id=event_id,
        actor=owner,
        updates=TournamentEventUpdate.model_validate(
            {
                "pools": [
                    _pool("p-b", "Pool B"),
                    _pool("p-c", "Pool C"),
                    _pool("p-a", "Pool A"),
                ]
            }
        ),
    )

    assert _named_positions(updated) == [("Pool B", 0), ("Pool C", 1), ("Pool A", 2)]

    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == event_id)
        )
    ).scalar_one()
    assert _named_positions(row) == [("Pool B", 0), ("Pool C", 1), ("Pool A", 2)]
    positions = [pool["position"] for pool in row.pools]
    assert len(set(positions)) == len(positions)


# ----- delete --------------------------------------------------------------


async def test_delete_removes_an_owned_event(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    owner = await make_user(db_session, "events-delete-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _add_event(db_session, tournament)
    event_id = event.id

    await delete_event(
        db_session,
        tournament_id=tournament.id,
        event_id=event_id,
        actor=owner,
    )

    db_session.expire_all()
    assert (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == event_id)
        )
    ).scalar_one_or_none() is None


async def test_delete_of_a_non_owned_event_raises_not_owner(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    owner = await make_user(db_session, "events-delete-guard-owner")
    stranger = await make_user(db_session, "events-delete-stranger")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _add_event(db_session, tournament)
    event_id = event.id

    with pytest.raises(NotTournamentOwnerError):
        await delete_event(
            db_session,
            tournament_id=tournament.id,
            event_id=event_id,
            actor=stranger,
        )

    # The event survives.
    db_session.expire_all()
    assert (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == event_id)
        )
    ).scalar_one_or_none() is not None


async def test_delete_of_a_missing_tournament_raises_not_found(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The tournament's 404 is judged before the event is even looked up."""
    actor = await make_user(db_session, "events-delete-missing-tournament")

    with pytest.raises(TournamentNotFoundError):
        await delete_event(
            db_session,
            tournament_id=uuid.uuid4(),
            event_id=uuid.uuid4(),
            actor=actor,
        )


async def test_delete_of_a_missing_event_raises_event_not_found(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The tournament exists and is owned, but names no such event — a 404 on the
    event, judged after the tournament's 404/403."""
    owner = await make_user(db_session, "events-delete-missing-event")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)

    with pytest.raises(EventNotFoundError):
        await delete_event(
            db_session,
            tournament_id=tournament.id,
            event_id=uuid.uuid4(),
            actor=owner,
        )


async def test_delete_of_an_event_under_a_different_tournament_raises_event_not_found(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A well-formed but mismatched pair — a real event id under the wrong tournament
    id — is a miss, not a cross-tournament edit (the id lookup is scoped by both)."""
    owner = await make_user(db_session, "events-delete-mismatch-owner")
    tournament_a = await _make_tournament(
        db_session, owner=owner, league=default_league
    )
    tournament_b = await _make_tournament(
        db_session, owner=owner, league=default_league
    )
    event_under_a = await _add_event(db_session, tournament_a)
    event_id = event_under_a.id

    with pytest.raises(EventNotFoundError):
        await delete_event(
            db_session,
            tournament_id=tournament_b.id,
            event_id=event_id,
            actor=owner,
        )

    # The event under A is untouched.
    db_session.expire_all()
    assert (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == event_id)
        )
    ).scalar_one_or_none() is not None


# ----- update --------------------------------------------------------------


async def _add_cut_event(
    db: AsyncSession,
    tournament: Tournament,
    *,
    draw_type: DrawType = DrawType.round_robin,
    timezone: str = "America/Chicago",
    scheduled_start: datetime | None = None,
) -> TournamentEvent:
    """An event carrying one pool (``p-1``) AND a fixture — so ``event_has_draw`` is
    True and the two freezes are live. The fixture optionally carries a
    ``scheduled_start`` placement, for the timezone-reanchor path."""
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Cut Singles",
        format=EventFormat.singles,
        draw_settings=TournamentEventDrawSettings.for_draw_type(draw_type),
        max_players=None,
        entry_fee=Decimal("0.00"),
        timezone=timezone,
        slot={"date": "2026-06-13", "start": "09:00", "end": "17:00"},
        match_settings={"rated": False, "length_games": 3},
        predicates=[],
        pools=[
            {
                "id": "p-1",
                "name": "Pool A",
                "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
                "table_ids": ["t1", "t2"],
            }
        ],
    )
    db.add(event)
    await db.commit()
    await db.refresh(event)
    fixture = TournamentFixture(
        event_id=event.id,
        pool_id="p-1",
        round=1,
        position=1,
        scheduled_start=scheduled_start,
    )
    db.add(fixture)
    await db.commit()
    return event


async def test_update_event_persists_a_normal_field_edit(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """An ordinary field edit (no draw, nothing frozen) applies and persists."""
    owner = await make_user(db_session, "events-update-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _add_event(db_session, tournament)
    event_id = event.id

    updated, league_id = await update_event(
        db_session,
        tournament_id=tournament.id,
        event_id=event_id,
        actor=owner,
        updates=TournamentEventUpdate.model_validate({"name": "Renamed Open"}),
    )

    # The verb returns the tournament's league_id beside the event (see create test).
    assert league_id == default_league.id
    assert updated.name == "Renamed Open"

    # Persisted, not merely returned.
    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == event_id)
        )
    ).scalar_one()
    assert row.name == "Renamed Open"


async def test_update_event_on_a_non_owned_tournament_raises_not_owner(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """404 → 403: a stranger is refused before anything is written."""
    owner = await make_user(db_session, "events-update-guard-owner")
    stranger = await make_user(db_session, "events-update-stranger")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _add_event(db_session, tournament)
    event_id = event.id

    with pytest.raises(NotTournamentOwnerError):
        await update_event(
            db_session,
            tournament_id=tournament.id,
            event_id=event_id,
            actor=stranger,
            updates=TournamentEventUpdate.model_validate({"name": "Hijacked"}),
        )

    # The name is unchanged.
    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == event_id)
        )
    ).scalar_one()
    assert row.name == "Existing Singles"


async def test_update_event_on_a_missing_event_raises_event_not_found(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The tournament exists and is owned, but names no such event — a 404 on the
    event, judged after the tournament's 404/403."""
    owner = await make_user(db_session, "events-update-missing-event")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)

    with pytest.raises(EventNotFoundError):
        await update_event(
            db_session,
            tournament_id=tournament.id,
            event_id=uuid.uuid4(),
            actor=owner,
            updates=TournamentEventUpdate.model_validate({"name": "Nope"}),
        )


async def test_update_event_frozen_pool_set_change_is_refused(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """Once the draw is cut, a ``pools`` payload that changes *which pools* the event
    has raises :class:`PoolSetFrozenError` and writes nothing (ADR-0786)."""
    owner = await make_user(db_session, "events-update-poolfreeze-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _add_cut_event(db_session, tournament)
    event_id = event.id

    updates = TournamentEventUpdate.model_validate(
        {
            "name": "Should Not Apply",
            "pools": [
                {
                    "id": "p-2",
                    "name": "Pool B",
                    "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
                    "table_ids": ["t1"],
                }
            ],
        }
    )
    with pytest.raises(PoolSetFrozenError):
        await update_event(
            db_session,
            tournament_id=tournament.id,
            event_id=event_id,
            actor=owner,
            updates=updates,
        )

    # Refused before the setattr loop: neither the pools nor the name were written.
    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == event_id)
        )
    ).scalar_one()
    assert row.name == "Cut Singles"
    assert [pool["id"] for pool in row.pools] == ["p-1"]


async def test_update_event_frozen_draw_type_change_is_refused(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """Once the draw is cut, a ``draw_type`` change raises
    :class:`DrawTypeFrozenError` and writes nothing (ADR-0786)."""
    owner = await make_user(db_session, "events-update-drawfreeze-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _add_cut_event(db_session, tournament, draw_type=DrawType.round_robin)
    event_id = event.id

    with pytest.raises(DrawTypeFrozenError):
        await update_event(
            db_session,
            tournament_id=tournament.id,
            event_id=event_id,
            actor=owner,
            updates=TournamentEventUpdate.model_validate(
                {"name": "Should Not Apply", "draw_type": "single-elim"}
            ),
        )

    # Refused before the write: draw type and name are both untouched.
    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == event_id)
        )
    ).scalar_one()
    assert row.draw_settings.draw_type is DrawType.round_robin
    assert row.name == "Cut Singles"


async def test_update_event_re_sending_the_same_draw_type_is_not_frozen(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """Re-sending the draw type the event already has changes nothing, so it is NOT
    refused even with a cut draw — the case the freeze exists to permit."""
    owner = await make_user(db_session, "events-update-samedraw-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _add_cut_event(db_session, tournament, draw_type=DrawType.round_robin)
    event_id = event.id

    updated, league_id = await update_event(
        db_session,
        tournament_id=tournament.id,
        event_id=event_id,
        actor=owner,
        updates=TournamentEventUpdate.model_validate(
            {"name": "Renamed Under Draw", "draw_type": "round-robin"}
        ),
    )

    assert league_id == default_league.id
    assert updated.name == "Renamed Under Draw"
    assert updated.draw_settings.draw_type is DrawType.round_robin


async def test_update_event_timezone_change_reanchors_placements(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A venue-timezone correction preserves the wall-clock of an already-placed
    fixture: its ``scheduled_start`` still reads 18:00 LOCAL in the NEW zone, its
    stored instant moving by the Chicago→Denver offset delta (ADR "Wall-clock is
    preserved across a timezone edit")."""
    owner = await make_user(db_session, "events-update-tz-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    placed_at = datetime(2026, 6, 13, 18, 0, tzinfo=ZoneInfo("America/Chicago"))
    event = await _add_cut_event(
        db_session,
        tournament,
        timezone="America/Chicago",
        scheduled_start=placed_at,
    )
    event_id = event.id

    await update_event(
        db_session,
        tournament_id=tournament.id,
        event_id=event_id,
        actor=owner,
        updates=TournamentEventUpdate.model_validate({"timezone": "America/Denver"}),
    )

    db_session.expire_all()
    fixture = (
        await db_session.execute(
            select(TournamentFixture).where(TournamentFixture.event_id == event_id)
        )
    ).scalar_one()
    assert fixture.scheduled_start is not None
    # Wall-clock preserved: still 18:00, now read in the NEW zone.
    reanchored = fixture.scheduled_start.astimezone(ZoneInfo("America/Denver"))
    assert (reanchored.hour, reanchored.minute) == (18, 0)
    assert reanchored.date() == placed_at.date()
    # The stored instant genuinely moved (Chicago 18:00 CDT != Denver 18:00 MDT).
    assert fixture.scheduled_start != placed_at
    assert fixture.scheduled_start == datetime(
        2026, 6, 13, 18, 0, tzinfo=ZoneInfo("America/Denver")
    )
