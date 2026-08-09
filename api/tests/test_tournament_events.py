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
from datetime import date, datetime, time
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from pydantic import BaseModel, ValidationError
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.draw_structure import (
    ONE_PLAYER_KNOCKOUT_MESSAGE,
    pool_too_small_message,
    too_many_qualifiers_message,
)
from app.models import (
    DrawType,
    EventFormat,
    League,
    Tournament,
    TournamentEvent,
    TournamentEventDrawSettings,
    TournamentEventPool,
    TournamentEventPoolTable,
    TournamentFixture,
    TournamentStatus,
    User,
)
from app.schemas.tournament import (
    Address,
    DrawStructure,
    PoolMembershipMode,
    StructuralSettingOwner,
    TournamentEventCreate,
    TournamentEventUpdate,
)
from app.tournament_draw_settings import draw_settings_of
from app.tournament_errors import (
    DrawTypeFrozenError,
    EventNotFoundError,
    ImpossibleDrawStructureError,
    NotTournamentOwnerError,
    PoolSetFrozenError,
    TournamentNotFoundError,
)
from app.tournament_events import create_event, delete_event, update_event
from app.tournament_pools import pool_read
from tests._helpers import (
    event_draw_settings,
    event_pools,
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
        # No ``table_ids``: a reservation is a row foreign-keyed to a real venue table
        # (ADR 20260801), so the only ids a payload can name are the uuids the server
        # minted for THIS tournament — which a module-level literal cannot know. The
        # reservation round trip has its own section at the foot of this file, built off
        # the tournament's real catalogue.
        # No ``id`` either: a pool id is a server-minted uuid (ADR 20260801), so the
        # create shape has no field for one and sending one is a 422.
        "pools": [
            {
                "name": "Pool A",
                "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
                "table_ids": [],
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
    # The pools persisted as rows of their own, not as a value inside the event, each
    # with an id the SERVER minted (ADR 20260801) — the payload carried none.
    assert [pool.name for pool in event.pools] == ["Pool A"]
    assert all(isinstance(pool.id, uuid.UUID) for pool in event.pools)
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
#     pool below is named so that alphabetical order is a DIFFERENT answer from the
#     order sent, which is what makes these able to fail — asserting "each pool has a
#     position" would pass against an implementation that assigned all zeros or sorted
#     by name.


def _pool(name: str, **extra: Any) -> dict[str, Any]:
    """One pool payload, valid but for whatever ``extra`` the caller adds."""
    return {
        "name": name,
        "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
        "table_ids": ["t1"],
        **extra,
    }


def _named_positions(event: TournamentEvent) -> list[tuple[str, int]]:
    """``(name, position)`` per stored pool, read off the ROWS in the relationship's
    order (which is ``position`` ascending).

    Names, not ids, because a pool named "Pool C" sitting at position 0 is the whole
    claim: it is the pool the director put first, and it is not the alphabetically first
    one. Read off the rows rather than through ``Pool`` so a default the schema supplies
    could not stand in for a value the write path failed to store — and the names are
    what discriminate, since ordering by position cannot itself reveal whether the
    positions were stamped from the payload's order or from the pools' names.
    """
    return [(pool.name, pool.position) for pool in event.pools]


async def test_create_positions_pools_by_the_order_they_were_sent(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """Three pools sent as **C, A, B** are stored as positions 0, 1, 2 *in that order*.

    Sorted by name — or by id, which is how pool order used to be recovered and which is
    now random — the answer would be C=2, A=0, B=1. Sorted by nothing at all it would
    be three zeros.
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
                _pool("Pool C"),
                _pool("Pool A"),
                _pool("Pool B"),
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
    positions = [pool.position for pool in row.pools]
    assert len(set(positions)) == len(positions)


_POOLS_CLAIMING_A_POSITION = [
    _pool("Pool C", position=7),
    _pool("Pool A", position=7),
    _pool("Pool B", position=7),
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
                _pool("Pool C"),
                _pool("Pool A"),
                _pool("Pool B"),
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
                    _pool("Pool B"),
                    _pool("Pool C"),
                    _pool("Pool A"),
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
    positions = [pool.position for pool in row.pools]
    assert len(set(positions)) == len(positions)


async def test_an_events_pools_are_rows_of_its_own_keyed_by_the_event(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A created event's pools are **rows in ``tournament_event_pools``**, each carrying
    the ``event_id`` that owns it and the window in the DATE/TIME columns the ADR pins
    (ADR 20260801, "a pool belongs to its event, not to the event's draw settings").

    Read with a **column-only** ``SELECT`` against the pools table, not off
    ``event.pools``: the relationship would answer just as happily if the pools were
    still a JSONB list on the event, and the claim here is precisely that they are not.

    The slot columns are asserted as real ``date``/``time`` VALUES rather than as
    strings, which is the same claim from the other side: a ``timestamptz`` column
    (api/CLAUDE.md's default rule, which the ADR deliberately excepts here) would read
    back as a ``datetime``, and this would fail on the type before the value.
    """
    owner = await make_user(db_session, "events-pools-are-rows")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)

    event, _ = await create_event(
        db_session,
        tournament_id=tournament.id,
        actor=owner,
        payload=_event_payload(pools=[_pool("Pool A"), _pool("Pool B")]),
    )
    event_id = event.id

    db_session.expire_all()
    rows = (
        await db_session.execute(
            select(
                TournamentEventPool.event_id,
                TournamentEventPool.id,
                TournamentEventPool.name,
                TournamentEventPool.position,
                TournamentEventPool.slot_date,
                TournamentEventPool.slot_start,
                TournamentEventPool.slot_end,
            ).order_by(TournamentEventPool.position)
        )
    ).all()

    # The ids are the server's (``gen_random_uuid()``), so what is asserted about them
    # is that they exist, are uuids, and are distinct — not their value, which no test
    # could spell.
    assert [(r[0], *r[2:]) for r in rows] == [
        (event_id, "Pool A", 0, date(2026, 6, 13), time(9, 0), time(12, 30)),
        (event_id, "Pool B", 1, date(2026, 6, 13), time(9, 0), time(12, 30)),
    ]
    assert len({r[1] for r in rows}) == 2
    assert all(isinstance(r[1], uuid.UUID) for r in rows)


@pytest.mark.parametrize(
    ("slot", "field"),
    [
        pytest.param(
            {"date": "next Tuesday", "start": "09:00", "end": "12:30"}, "date"
        ),
        pytest.param({"date": "2026-06-13", "start": "9am", "end": "12:30"}, "start"),
        pytest.param(
            {"date": "2026-06-13", "start": "09:00:30", "end": "12:30"}, "seconds"
        ),
    ],
    ids=["unparseable-date", "unparseable-start", "a-time-carrying-seconds"],
)
def test_a_pool_window_the_columns_cannot_hold_is_refused(
    slot: dict[str, str], field: str
) -> None:
    """A pool window that is not ``YYYY-MM-DD`` + ``HH:MM`` is a **422 at the
    boundary**, not a driver error at the INSERT.

    The three strings used to sit inside a JSONB blob that accepted anything at all;
    they are ``slot_date DATE`` / ``slot_start TIME`` / ``slot_end TIME`` now (ADR
    20260801), so a boundary that let ``"next Tuesday"`` through would be handing the
    director a 500 for a payload it had just accepted — the ``EventMaxPlayers`` lesson
    in another key (api/CLAUDE.md, "a boundary that admits what the interior cannot
    hold is not a boundary").

    Seconds are in the matrix deliberately: ``09:00:30`` parses perfectly well and is
    the one case a *refusal* has to be argued for. It would be stored and then read
    back as ``09:00``, moving a director's window by half a minute in a direction
    nothing told them about; the wire shape says ``HH:MM``, so the round trip stays
    lossless and the refusal says what to send.
    """
    with pytest.raises(ValidationError) as refusal:
        TournamentEventCreate.model_validate(
            _event_body(pools=[_pool("Pool A", slot=slot)])
        )

    (error,) = refusal.value.errors()
    assert error["loc"] == ("pools", 0, "slot"), field


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
    qualifiers_per_pool: int | None = None,
    draw_structure: DrawStructure | None = None,
    timezone: str = "America/Chicago",
    scheduled_start: datetime | None = None,
) -> TournamentEvent:
    """An event carrying one pool (named "Pool A") AND a fixture — so ``event_has_draw``
    is True and the two freezes are live. The fixture optionally carries a
    ``scheduled_start`` placement, for the timezone-reanchor path.

    The pool's id is minted here (``event_pools``) rather than by the column's default,
    because the fixture below has to name it before either row is flushed.

    The settings row goes through ``event_draw_settings``, which routes the pair through
    the same parse the request boundary uses — so a draw type that REQUIRES a setting
    (``rr-then-ko``'s qualifier count) reds here when the seed omits it, rather than
    writing a row the app could not have made and failing at the next read."""
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Cut Singles",
        format=EventFormat.singles,
        draw_settings=event_draw_settings(
            draw_type,
            qualifiers_per_pool=qualifiers_per_pool,
            draw_structure=draw_structure,
        ),
        max_players=None,
        entry_fee=Decimal("0.00"),
        timezone=timezone,
        slot={"date": "2026-06-13", "start": "09:00", "end": "17:00"},
        match_settings={"rated": False, "length_games": 3},
        predicates=[],
        pools=event_pools(
            [
                {
                    "name": "Pool A",
                    "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
                    "table_ids": ["t1", "t2"],
                }
            ],
            tournament=tournament,
        ),
    )
    db.add(event)
    await db.commit()
    await db.refresh(event)
    fixture = TournamentFixture(
        event_id=event.id,
        pool_id=event.pools[0].id,
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
    assert [pool.name for pool in row.pools] == ["Pool A"]


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


async def test_update_event_changing_only_an_ownership_mode_is_not_frozen(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A cut draw does NOT freeze the ownership modes: a director may say who owns the
    pool count, or that they will place entrants at cut time, while fixtures stand.

    The freeze exists to stop a payload contradicting fixtures that already exist (ADR-
    0786). The modes contradict none: the pools a cut draw has are its pool rows, which
    their own freeze already holds, and membership is dealt by the snake either way
    until the cut screen exists (#1324). What the fixtures WERE dealt from — the draw
    type and the qualifier count — is still frozen, and the test above and its neighbour
    say so.

    Without the exemption this edit would be refused, and refused in the qualifier
    count's words: ``_draw_settings_frozen_detail`` asks the arm which setting moved,
    and the ``rr-then-ko`` arm answers "the number of qualifiers per pool is frozen" for
    any change at all. A refusal naming a number the director never touched is the
    defect
    #1320 was filed about, so this is the test that keeps
    ``configuration_the_draw_was_dealt_from`` from being deleted as dead weight.
    """
    owner = await make_user(db_session, "events-update-modes-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _add_cut_event(
        db_session,
        tournament,
        draw_type=DrawType.rr_then_ko,
        qualifiers_per_pool=2,
    )
    event_id = event.id

    updated, _ = await update_event(
        db_session,
        tournament_id=tournament.id,
        event_id=event_id,
        actor=owner,
        updates=TournamentEventUpdate.model_validate(
            {
                "draw_type": "rr-then-ko",
                "qualifiers_per_pool": 2,
                "draw_structure": {
                    "pool_count_mode": "manual",
                    "manual_pool_count": 4,
                    "membership_mode": "manual",
                },
            }
        ),
    )

    stored = draw_settings_of(updated.draw_settings)
    assert stored.draw_structure == DrawStructure(
        pool_count_mode=StructuralSettingOwner.manual,
        manual_pool_count=4,
        membership_mode=PoolMembershipMode.manual,
    )
    # The qualifier count is untouched by the edit, which is what makes this a test
    # about the modes rather than about a configuration that happened to be equal
    # anyway.
    assert stored.qualifiers_per_pool == 2


#: What a director owns on the events the two tests below edit: a pool count they typed,
#: a pool size they typed and then handed back to the system, and hand assignment at cut
#: time. Three different numbers and one non-default membership, so a patch that lost or
#: swapped any of them reds.
_DIRECTOR_OWNED_STRUCTURE = DrawStructure(
    pool_count_mode=StructuralSettingOwner.manual,
    manual_pool_count=6,
    pool_size_mode=StructuralSettingOwner.automatic,
    manual_pool_size=5,
    membership_mode=PoolMembershipMode.manual,
)


async def test_update_event_omitting_the_structure_leaves_the_stored_modes_alone(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A patch that names the draw configuration but sends **no** ``draw_structure``
    leaves the director's ownership exactly as it was. Omitted is unchanged.

    This is the rule every other field on this verb already follows — ``changes`` is
    ``model_dump(exclude_unset=True)``, so a key the caller never sent is not in it and
    nothing is written. The draw configuration cannot get that for free, because it is
    rebuilt as a whole arm from the loose fields beside ``draw_type``, and a rebuilt
    arm fills ``draw_structure`` with the model's default of all-automatic. So the
    patch path resolves the omission against the stored arm
    (``TournamentEventUpdate.draw_settings_over``).

    Without that, the damage would not have been theoretical or rare. Today's iOS app
    and the MCP server both patch events and neither knows this field exists, so **a
    rename would have discarded a pool count the director typed on the web** — the
    silent change the ownership ADR forbids outright. It would also have slipped past
    the freeze on a cut draw, because the modes are deliberately not part of what the
    freeze compares.

    A cut event is used here for exactly that reason: it is the case with no second line
    of defence.
    """
    owner = await make_user(db_session, "events-update-structure-kept-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _add_cut_event(
        db_session,
        tournament,
        draw_type=DrawType.rr_then_ko,
        qualifiers_per_pool=2,
        draw_structure=_DIRECTOR_OWNED_STRUCTURE,
    )
    event_id = event.id
    # The seed is asserted before the edit. Without this the test would pass against an
    # event that never had a manual mode to lose, which is the shape of "green because
    # nothing happened".
    seeded = draw_settings_of(event.draw_settings)
    assert seeded.draw_structure == _DIRECTOR_OWNED_STRUCTURE

    updated, _ = await update_event(
        db_session,
        tournament_id=tournament.id,
        event_id=event_id,
        actor=owner,
        updates=TournamentEventUpdate.model_validate(
            {
                "name": "Renamed By An Older Client",
                "draw_type": "rr-then-ko",
                "qualifiers_per_pool": 2,
            }
        ),
    )

    assert updated.name == "Renamed By An Older Client"
    stored = draw_settings_of(updated.draw_settings)
    assert stored.draw_structure == _DIRECTOR_OWNED_STRUCTURE, (
        "a patch that never mentioned draw_structure must not touch it: the director's "
        "pool count, their remembered pool size and their membership choice all survive"
    )

    # Persisted, not merely returned — the resolved arm reached the settings row.
    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == event_id)
        )
    ).scalar_one()
    assert draw_settings_of(row.draw_settings).draw_structure == (
        _DIRECTOR_OWNED_STRUCTURE
    )


async def test_update_event_sending_a_structure_replaces_the_stored_one_wholesale(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The other half of the rule: a structure that IS sent replaces the stored one
    entirely, mode by mode, including back to automatic.

    Both semantics have to be pinned together, because the fix for the omission case is
    a carry-forward and the obvious over-correction is to merge the two structures
    instead of replacing. A merge would make "Use automatic" unsendable — the click
    that returns a setting to the system would arrive as a field with nothing in it and
    be read as "unstated".

    So the sent structure wins in full: the manual pool count is gone because this
    payload says pool count is automatic, and the remembered pool size is gone with it
    because this payload does not carry one.
    """
    owner = await make_user(db_session, "events-update-structure-replaced-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _add_cut_event(
        db_session,
        tournament,
        draw_type=DrawType.rr_then_ko,
        qualifiers_per_pool=2,
        draw_structure=_DIRECTOR_OWNED_STRUCTURE,
    )
    event_id = event.id

    updated, _ = await update_event(
        db_session,
        tournament_id=tournament.id,
        event_id=event_id,
        actor=owner,
        updates=TournamentEventUpdate.model_validate(
            {
                "draw_type": "rr-then-ko",
                "qualifiers_per_pool": 2,
                "draw_structure": {
                    "pool_size_mode": "manual",
                    "manual_pool_size": 8,
                },
            }
        ),
    )

    stored = draw_settings_of(updated.draw_settings)
    assert stored.draw_structure == DrawStructure(
        pool_size_mode=StructuralSettingOwner.manual,
        manual_pool_size=8,
    ), (
        "a sent structure is the whole structure: pool count is back to automatic with "
        "no remembered number, and membership is back to the snake"
    )


async def test_update_event_changing_the_qualifier_count_is_still_frozen(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The other side of the exemption above: the qualifier count a cut bracket was
    sized from is still frozen, and a patch that moves it is still refused (ADR
    20260727).

    Sent with a structure alongside it, because that is the shape the editor sends and
    because the exemption must not become "any payload carrying a structure passes"."""
    owner = await make_user(db_session, "events-update-frozen-k-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _add_cut_event(
        db_session,
        tournament,
        draw_type=DrawType.rr_then_ko,
        qualifiers_per_pool=2,
    )
    event_id = event.id

    with pytest.raises(DrawTypeFrozenError) as refusal:
        await update_event(
            db_session,
            tournament_id=tournament.id,
            event_id=event_id,
            actor=owner,
            updates=TournamentEventUpdate.model_validate(
                {
                    "draw_type": "rr-then-ko",
                    "qualifiers_per_pool": 3,
                    "draw_structure": {"membership_mode": "manual"},
                }
            ),
        )
    assert "qualifiers per pool is frozen" in str(refusal.value)


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


# ----- a pool's table reservations (ADR 20260801) ---------------------------
#
# The tables a pool reserves are rows now — ``tournament_event_pool_tables`` — where
# they were a JSONB array of strings that could name anything at all. Three claims live
# down here, and only the first is visible through the wire shape:
#
#   * a reservation round-trips through rows, in the order it was sent;
#   * a pool cannot reserve **another tournament's** table, and it is the DATABASE that
#     says so — the two spellings of that illegal state are refused by two different
#     legs of the same three-legged key;
#   * removing a table takes the reservations that named it, quietly, because a
#     reservation is a preference and only a placement is a commitment.

#: The leg that catches a reservation naming a table of a tournament other than the one
#: the row claims to be inside.
POOL_TABLE_TABLE_CONSTRAINT = "fk_tournament_event_pool_tables_tournament_id_table_id"
#: The leg that catches a reservation whose claimed tournament is not the one its pool's
#: event belongs to — the one that looks redundant and is not (see the model).
POOL_TABLE_EVENT_CONSTRAINT = "fk_tournament_event_pool_tables_tournament_id_event_id"


async def _reservation_rows(
    db: AsyncSession, event_id: uuid.UUID
) -> list[tuple[uuid.UUID, str, str, int]]:
    """``(tournament_id, pool_id, table_id, position)`` per stored reservation of this
    event, in pool then position order.

    A column-only ``SELECT`` so it reads the rows and not the session's opinion of them:
    two of the tests below delete rows out from under loaded ORM instances (that is the
    behaviour under test), and a collection read off those instances would answer with
    what the session last saw.
    """
    return [
        (tournament_id, pool_id, table_id, position)
        for tournament_id, pool_id, table_id, position in (
            await db.execute(
                select(
                    TournamentEventPoolTable.tournament_id,
                    TournamentEventPoolTable.pool_id,
                    TournamentEventPoolTable.table_id,
                    TournamentEventPoolTable.position,
                )
                .where(TournamentEventPoolTable.event_id == event_id)
                .order_by(
                    TournamentEventPoolTable.pool_id,
                    TournamentEventPoolTable.position,
                )
            )
        ).all()
    ]


def _pool_payload(*table_ids: str, name: str = "Pool A") -> dict[str, Any]:
    """One pool reserving exactly ``table_ids``, in that order."""
    return {
        "name": name,
        "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
        "table_ids": list(table_ids),
    }


async def test_a_pools_reservations_are_stored_as_rows_in_the_order_they_were_sent(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A pool reserves its tables through **rows**, not a string array — and the wire
    shape is unchanged, because ``table_ids`` is composed back from them.

    The two tables are named in *reverse* catalogue order, which is what makes this able
    to fail: rows have no inherent order, and reading them back by ``table_id`` (a
    random uuid) or by insertion happenstance would give the director's list back
    shuffled. ``position`` is what carries the order the payload stated, exactly as it
    does for the pools themselves and for the venue catalogue.
    """
    owner = await make_user(db_session, "events-reservation-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id
    table_1, table_2 = [str(table.id) for table in tournament.tables]

    event, _ = await create_event(
        db_session,
        tournament_id=tournament_id,
        actor=owner,
        payload=_event_payload(pools=[_pool_payload(table_2, table_1)]),
    )
    event_id = event.id
    pool_id = event.pools[0].id

    # Rows, carrying the denormalized tournament and the order sent.
    db_session.expire_all()
    assert await _reservation_rows(db_session, event_id) == [
        (tournament_id, pool_id, table_2, 0),
        (tournament_id, pool_id, table_1, 1),
    ]
    # And the same order back through the read shape everything above the database uses.
    stored = (
        await db_session.execute(
            select(TournamentEventPool).where(TournamentEventPool.event_id == event_id)
        )
    ).scalar_one()
    assert pool_read(stored).table_ids == [table_2, table_1]


async def test_a_reservation_of_another_tournaments_table_never_reaches_the_database(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A payload naming a table of somebody *else's* tournament reserves nothing, and
    the event is created anyway.

    This is the quiet half of the ADR's split said at the write boundary: a reservation
    is a **preference**, so an id that names no table of this tournament is simply not a
    preference this schema can hold — where a *placement* naming an unknown table is the
    422 ``test_tournament_placement`` pins. Nothing observable changes: every reader
    already intersected ``table_ids`` with the catalogue, because a JSONB string could
    name anything.

    The row the write path declines to compose is one the database would refuse anyway,
    which the next two tests prove directly.
    """
    owner = await make_user(db_session, "events-foreign-reservation-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    stranger = await make_user(db_session, "events-foreign-reservation-other")
    other = await _make_tournament(db_session, owner=stranger, league=default_league)
    foreign_table = str(other.tables[0].id)
    tournament_id = tournament.id
    mine = str(tournament.tables[0].id)

    event, _ = await create_event(
        db_session,
        tournament_id=tournament_id,
        actor=owner,
        payload=_event_payload(pools=[_pool_payload(mine, foreign_table)]),
    )
    event_id = event.id
    pool_id = event.pools[0].id

    db_session.expire_all()
    assert await _reservation_rows(db_session, event_id) == [
        (tournament_id, pool_id, mine, 0)
    ]


async def test_a_pool_table_reservation_across_tournaments_is_refused_by_the_database(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The claim the composite foreign keys exist to make (ADR 20260801): a pool cannot
    reserve another tournament's table — and it is the **database** that says so, not
    the write path above it.

    The illegal state has two spellings, and each is caught by a *different* leg of the
    three-legged key, which is why it takes three:

    * claim my own tournament, name the other one's table → the
      ``(tournament_id, table_id)`` leg finds no such table under my tournament. **A
      plain ``REFERENCES tournament_tables (id)`` would accept this row**: the table
      exists, which was never the question. Compositeness is what is doing the work.
    * claim the other tournament (so its table resolves) → the
      ``(tournament_id, event_id)`` leg finds no such event under it. Without that third
      leg the first two are both satisfied and the row goes in, which is exactly the
      reservation this table exists to forbid.

    Both are refused at the INSERT: unlike the fixture's ``(event_id, pool_id)``, none
    of these constraints is deferred — no delete path needs them to be.
    """
    owner = await make_user(db_session, "events-cross-reservation-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    stranger = await make_user(db_session, "events-cross-reservation-other")
    other = await _make_tournament(db_session, owner=stranger, league=default_league)
    foreign_table = str(other.tables[0].id)
    tournament_id, other_id = tournament.id, other.id
    event, _ = await create_event(
        db_session,
        tournament_id=tournament_id,
        actor=owner,
        payload=_event_payload(pools=[_pool_payload()]),
    )
    event_id = event.id
    pool_id = event.pools[0].id

    db_session.add(
        TournamentEventPoolTable(
            tournament_id=tournament_id,
            event_id=event_id,
            pool_id=pool_id,
            table_id=foreign_table,
            position=0,
        )
    )
    with pytest.raises(IntegrityError) as excinfo:
        await db_session.commit()
    assert POOL_TABLE_TABLE_CONSTRAINT in str(excinfo.value)
    await db_session.rollback()

    db_session.add(
        TournamentEventPoolTable(
            tournament_id=other_id,
            event_id=event_id,
            pool_id=pool_id,
            table_id=foreign_table,
            position=0,
        )
    )
    with pytest.raises(IntegrityError) as excinfo:
        await db_session.commit()
    assert POOL_TABLE_EVENT_CONSTRAINT in str(excinfo.value)
    await db_session.rollback()

    # Neither refusal left anything behind.
    assert await _reservation_rows(db_session, event_id) == []


async def test_a_reservation_naming_no_table_at_all_is_refused_by_the_database(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The plainer half of the same key: a ``table_id`` naming no table anywhere.

    It was storable for as long as a pool's tables were strings in a JSONB array — the
    dangling reference ADR-0790 could only shrug at, and the reason "this id names a
    table" had to be re-derived by every reader. It is a foreign-key violation now."""
    owner = await make_user(db_session, "events-dangling-reservation-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id
    event, _ = await create_event(
        db_session,
        tournament_id=tournament_id,
        actor=owner,
        payload=_event_payload(pools=[_pool_payload()]),
    )

    db_session.add(
        TournamentEventPoolTable(
            tournament_id=tournament_id,
            event_id=event.id,
            pool_id=event.pools[0].id,
            table_id=str(uuid.uuid4()),
            position=0,
        )
    )
    with pytest.raises(IntegrityError) as excinfo:
        await db_session.commit()
    assert POOL_TABLE_TABLE_CONSTRAINT in str(excinfo.value)
    await db_session.rollback()


async def test_removing_a_table_drops_the_pool_reservations_that_named_it(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """Deleting a venue table takes the reservations naming it — and only those — with
    no error and no ceremony.

    This is the ADR's asymmetry, from the reservation's side. A fixture *placed* at a
    table blocks the delete (``ON DELETE RESTRICT``) so the director can be asked; a
    pool that merely *reserves* it is not consulted, because a table breaking or freeing
    up is ordinary venue traffic and the pool simply reserves one fewer. Under the JSONB
    array the pool went on listing the dead id forever; the CASCADE is what makes
    "reserves one fewer" true in the database rather than derived by every reader.

    Deleted at the row, deliberately, rather than through the tournament-edit verb: this
    is a claim about the constraint, and the verb's own 409/opt-in path is pinned in
    ``test_tournaments.py``. The surviving reservation is asserted too — a cascade that
    took the whole pool's reservations would satisfy "the dead one is gone".
    """
    owner = await make_user(db_session, "events-table-cascade-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id
    table_1, table_2 = [str(table.id) for table in tournament.tables]
    doomed = tournament.tables[1]
    event, _ = await create_event(
        db_session,
        tournament_id=tournament_id,
        actor=owner,
        payload=_event_payload(pools=[_pool_payload(table_1, table_2)]),
    )
    event_id = event.id
    pool_id = event.pools[0].id

    await db_session.delete(doomed)
    await db_session.commit()

    db_session.expire_all()
    assert await _reservation_rows(db_session, event_id) == [
        (tournament_id, pool_id, table_1, 0)
    ]
    # The pool itself is untouched — a reservation went, not a pool.
    assert (
        await db_session.execute(
            select(TournamentEventPool.id).where(
                TournamentEventPool.event_id == event_id
            )
        )
    ).scalars().all() == [pool_id]


async def test_removing_a_pool_takes_its_table_reservations_with_it(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A pool dropped from a PATCH takes its reservations with it, through the same
    ``delete-orphan``/CASCADE pair the pool itself goes by — so no reservation outlives
    the pool that made it."""
    owner = await make_user(db_session, "events-pool-cascade-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id
    table_1, _table_2 = [str(table.id) for table in tournament.tables]
    event, _ = await create_event(
        db_session,
        tournament_id=tournament_id,
        actor=owner,
        payload=_event_payload(pools=[_pool_payload(table_1)]),
    )
    event_id = event.id

    await update_event(
        db_session,
        tournament_id=tournament_id,
        event_id=event_id,
        actor=owner,
        updates=TournamentEventUpdate.model_validate({"pools": []}),
    )

    db_session.expire_all()
    assert await _reservation_rows(db_session, event_id) == []


async def test_re_sending_a_reservation_keeps_its_row_and_re_orders_the_rest(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The reservations are written as a **diff** keyed on the table id, not replaced
    wholesale — and a reorder is expressible.

    Both halves matter and they are the same mechanism. A wholesale replace would ask
    the unit of work to INSERT a primary key it is about to DELETE (it emits the inserts
    first), so re-sending a table the pool already reserves would die on
    ``pk_tournament_event_pool_tables``. And swapping two reservations moves one onto a
    ``position`` the other has not vacated yet, which is why the uniqueness on
    ``(event_id, pool_id, position)`` is ``DEFERRABLE INITIALLY DEFERRED`` — checked
    immediately it would refuse a transaction whose end state is perfectly unique.

    The ``created_at`` of the surviving row is what says its identity was *kept* rather
    than deleted and re-made under the same key: a re-inserted row would carry a fresh
    one.
    """
    owner = await make_user(db_session, "events-reservation-diff-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id
    table_1, table_2 = [str(table.id) for table in tournament.tables]
    event, _ = await create_event(
        db_session,
        tournament_id=tournament_id,
        actor=owner,
        payload=_event_payload(pools=[_pool_payload(table_1, table_2)]),
    )
    event_id = event.id
    pool_id = event.pools[0].id
    created_at = (
        await db_session.execute(
            select(TournamentEventPoolTable.created_at).where(
                TournamentEventPoolTable.event_id == event_id,
                TournamentEventPoolTable.table_id == table_1,
            )
        )
    ).scalar_one()

    await update_event(
        db_session,
        tournament_id=tournament_id,
        event_id=event_id,
        actor=owner,
        updates=TournamentEventUpdate.model_validate(
            # The pool is CITED by the id the server minted, so the diff keeps its row —
            # which is the whole premise of the claim below about its reservations.
            {"pools": [{**_pool_payload(table_2, table_1), "id": str(pool_id)}]}
        ),
    )

    db_session.expire_all()
    assert await _reservation_rows(db_session, event_id) == [
        (tournament_id, pool_id, table_2, 0),
        (tournament_id, pool_id, table_1, 1),
    ]
    assert (
        await db_session.execute(
            select(TournamentEventPoolTable.created_at).where(
                TournamentEventPoolTable.event_id == event_id,
                TournamentEventPoolTable.table_id == table_1,
            )
        )
    ).scalar_one() == created_at


# ----- an unplayable draw structure (#1320) ---------------------------------
#
# The three impossible competitions used to be refused at the CUT, hours after the save
# that authored them and in a sentence that named the cut. They are refused at the write
# now, in the derivation's own words (``app.draw_structure``), on both verbs.
#
# What every test down here is really about is WHICH STATE is judged. It is the state
# the request would leave the event in — never the fields the request carries — because
# the director this issue is about already has an impossible event, and the only way out
# of one is a request that moves two numbers at once.


def _pool_list(count: int) -> list[dict[str, Any]]:
    """``count`` pool rows, named A, B, C…

    Only the COUNT matters to the derivation: an event's pool count is the number of its
    pool rows (ADR "an event's pool count is its pool rows and a derived count is a
    projection"), and nothing else about a pool reaches the arithmetic.
    """
    return [
        {
            "name": f"Pool {chr(ord('A') + index)}",
            "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
            "table_ids": [],
        }
        for index in range(count)
    ]


async def _add_impossible_event(
    db: AsyncSession, tournament: Tournament
) -> TournamentEvent:
    """An event that is **already unplayable**, seeded straight through the ORM.

    It has to be seeded, not created: ``create_event`` is exactly what now refuses this
    configuration, so a test about escaping one cannot use it to build one. Which is not
    a contrivance — the rows it writes are the rows the app wrote happily until this
    chore, and every director holding one today got it that way.

    Four pool rows against a cap of four: the balanced split is ``1, 1, 1, 1``, and each
    of those four players would have nobody to play.
    """
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Impossible Singles",
        format=EventFormat.singles,
        draw_settings=event_draw_settings(DrawType.rr_then_ko, qualifiers_per_pool=2),
        max_players=4,
        entry_fee=Decimal("0.00"),
        timezone="America/Chicago",
        slot={"date": "2026-06-13", "start": "09:00", "end": "17:00"},
        match_settings={"rated": False, "length_games": 3},
        predicates=[],
        pools=event_pools(_pool_list(4)),
    )
    db.add(event)
    await db.commit()
    await db.refresh(event)
    return event


@pytest.mark.parametrize(
    ("username", "why", "overrides", "expected"),
    [
        (
            "events-impossible-pool",
            "four players across four pools leaves four pools of one",
            {"max_players": 4, "pools": _pool_list(4), "qualifiers_per_pool": 2},
            pool_too_small_message(4, 4),
        ),
        (
            "events-impossible-bracket",
            "one pool taking its top one leaves a knockout of one",
            {
                "max_players": 8,
                "pools": _pool_list(1),
                "qualifiers_per_pool": 1,
                "draw_structure": {"qualifiers_mode": "manual"},
            },
            ONE_PLAYER_KNOCKOUT_MESSAGE,
        ),
        (
            "events-impossible-qualifier",
            "five qualifiers out of pools of four is five out of four",
            {
                "max_players": 8,
                "pools": _pool_list(2),
                "qualifiers_per_pool": 5,
                "draw_structure": {"qualifiers_mode": "manual"},
            },
            too_many_qualifiers_message(5, 4),
        ),
    ],
    ids=["a pool of one", "a knockout of one", "too many qualifiers"],
)
async def test_create_refuses_a_competition_that_cannot_be_played(
    db_session: AsyncSession,
    default_league: League,
    username: str,
    why: str,
    overrides: dict[str, Any],
    expected: str,
) -> None:
    """Each of the three impossible competitions is refused at the create, in the
    derivation's own sentence, and nothing is written.

    The words are asserted rather than the exception type alone, because the sentence is
    the whole point of moving the refusal here: the cut already said all three, hours
    later, and #1320 is a complaint about a refusal that named the wrong cause.

    Note which numbers the first case leans on. It is judged against the event's **pool
    rows** and its **cap** — neither of them a setting the director typed — and the
    qualifier count it carries is never read, because that mode is automatic.
    """
    owner = await make_user(db_session, username)
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id

    with pytest.raises(ImpossibleDrawStructureError) as refusal:
        await create_event(
            db_session,
            tournament_id=tournament_id,
            actor=owner,
            payload=_event_payload(draw_type="rr-then-ko", **overrides),
        )

    assert str(refusal.value) == expected, why
    db_session.expire_all()
    assert (
        await db_session.execute(
            select(func.count())
            .select_from(TournamentEvent)
            .where(TournamentEvent.tournament_id == tournament_id)
        )
    ).scalar_one() == 0, why


async def test_create_accepts_numbers_that_merely_disagree(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """Six pools of five seat thirty and the field is forty. **That saves.**

    A disagreement is not a refusal (ADR "a structural setting is owned by the director
    or derived by the system"): both numbers were typed on purpose, so the app states
    the arithmetic rather than reshaping one of them, and the director may be about to
    raise the cap or add the rows. Only the *cut* is unavailable.

    It is asserted here rather than left implied because it is the easiest thing for
    this guard to break — one ``if derived.disagreement`` too many and every
    part-configured event stops saving, which is slice 5's whole premise gone.
    """
    owner = await make_user(db_session, "events-disagreement-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)

    event, _ = await create_event(
        db_session,
        tournament_id=tournament.id,
        actor=owner,
        payload=_event_payload(
            draw_type="rr-then-ko",
            qualifiers_per_pool=2,
            max_players=40,
            pools=_pool_list(6),
            draw_structure={
                "pool_count_mode": "manual",
                "manual_pool_count": 6,
                "pool_size_mode": "manual",
                "manual_pool_size": 5,
            },
        ),
    )

    stored = draw_settings_of(event.draw_settings)
    assert stored.draw_structure == DrawStructure(
        pool_count_mode=StructuralSettingOwner.manual,
        manual_pool_count=6,
        pool_size_mode=StructuralSettingOwner.manual,
        manual_pool_size=5,
    )


async def test_create_leaves_the_other_draw_types_alone(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """Four pool rows against a cap of four is unplayable as an ``rr-then-ko`` event and
    perfectly ordinary as a **round-robin** one, which saves.

    The three conditions are about a pool stage feeding a knockout, and no other draw
    type has one — a round robin plays its pools and stops, a bracket has no pools at
    all, and swiss is pool-less. So the guard is scoped to the one arm that carries a
    draw structure, and this is the test that says a new refusal did not quietly become
    every draw type's problem.
    """
    owner = await make_user(db_session, "events-other-draw-types-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)

    event, _ = await create_event(
        db_session,
        tournament_id=tournament.id,
        actor=owner,
        payload=_event_payload(
            draw_type="round-robin", max_players=4, pools=_pool_list(4)
        ),
    )

    assert event.max_players == 4
    assert len(event.pools) == 4


async def test_update_refuses_a_cap_that_would_starve_this_events_pools(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A patch carrying only ``max_players`` is refused, because of the pools it does
    **not** carry.

    This is the post-state rule doing its work in the ordinary direction: the cap comes
    from the payload, the pool rows come from the event, and the competition the two
    describe together is the one judged. A guard reading only the fields the request
    stated would see a legal number and let a director lower a cap onto four pools that
    then hold one player each.
    """
    owner = await make_user(db_session, "events-cap-starves-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event, _ = await create_event(
        db_session,
        tournament_id=tournament.id,
        actor=owner,
        payload=_event_payload(
            draw_type="rr-then-ko",
            qualifiers_per_pool=2,
            max_players=16,
            pools=_pool_list(4),
        ),
    )
    event_id = event.id

    with pytest.raises(ImpossibleDrawStructureError) as refusal:
        await update_event(
            db_session,
            tournament_id=tournament.id,
            event_id=event_id,
            actor=owner,
            updates=TournamentEventUpdate.model_validate({"max_players": 4}),
        )

    assert str(refusal.value) == pool_too_small_message(4, 4)
    db_session.expire_all()
    persisted = (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == event_id)
        )
    ).scalar_one()
    assert persisted.max_players == 16


async def test_update_lets_a_director_out_of_an_event_that_is_already_impossible(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """**The escape.** An event that is already unplayable takes the one request that
    fixes it — and that request has to move two numbers at once.

    Four pools of one, against a cap of four. Taking two qualifiers alone leaves the
    pools of one, so the pool count has to move as well, and this request moves both —
    the case the ADR says the post-state rule exists for: "their event is already
    impossible, and they must be able to change pool count and qualifiers in one
    request".

    Halving the pools alone would now be enough on its own, because an automatic
    qualifier count never exceeds the smallest pool: two pools of two derive two
    qualifiers, not four. So a request carrying both numbers is the shape a director
    with a MANUAL qualifier count needs, which is the one this test sends.

    Judging the DELTA instead — refusing any number a request states that leaves the
    event impossible — would red exactly here, with the director stuck.
    """
    owner = await make_user(db_session, "events-escape-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _add_impossible_event(db_session, tournament)
    event_id = event.id
    kept = [
        str(pool.id) for pool in sorted(event.pools, key=lambda pool: pool.position)
    ][:2]

    updated, _ = await update_event(
        db_session,
        tournament_id=tournament.id,
        event_id=event_id,
        actor=owner,
        updates=TournamentEventUpdate.model_validate(
            {
                # Two pool rows, cited by ids the event already has, so the other two
                # are removed — a pool count IS its pool rows.
                "pools": [
                    {**pool, "id": pool_id}
                    for pool, pool_id in zip(_pool_list(2), kept, strict=True)
                ],
                "draw_type": "rr-then-ko",
                "qualifiers_per_pool": 2,
                "draw_structure": {"qualifiers_mode": "manual"},
            }
        ),
    )

    assert len(updated.pools) == 2
    stored = draw_settings_of(updated.draw_settings)
    assert stored.qualifiers_per_pool == 2
    assert stored.draw_structure is not None
    assert stored.draw_structure.qualifiers_mode is StructuralSettingOwner.manual


async def test_update_refuses_an_edit_that_leaves_the_event_impossible(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The other half of the escape, and the price of it: renaming an already-impossible
    event is refused, because the event is still impossible afterwards.

    Only the save is judged, and it is judged on the result — so a patch that leaves an
    unplayable competition unplayable is refused however innocent the field it carries
    (ADR: "only the save is refused, and only while the result would still be
    impossible"). The way out is to fix the numbers, which the test above proves is
    available in one request.
    """
    owner = await make_user(db_session, "events-still-impossible-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _add_impossible_event(db_session, tournament)
    event_id = event.id

    with pytest.raises(ImpossibleDrawStructureError) as refusal:
        await update_event(
            db_session,
            tournament_id=tournament.id,
            event_id=event_id,
            actor=owner,
            updates=TournamentEventUpdate.model_validate({"name": "Renamed Singles"}),
        )

    assert str(refusal.value) == pool_too_small_message(4, 4)
    db_session.expire_all()
    persisted = (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == event_id)
        )
    ).scalar_one()
    assert persisted.name == "Impossible Singles"
