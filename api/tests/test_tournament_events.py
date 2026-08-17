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
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.models import (
    DrawType,
    EventFormat,
    League,
    Tournament,
    TournamentEvent,
    TournamentEventDrawSettings,
    TournamentEventReservation,
    TournamentEventReservationTable,
    TournamentEventStage,
    TournamentEventStageGroup,
    TournamentFixture,
    TournamentStatus,
    User,
)
from app.schemas.tournament import Address, TournamentEventCreate, TournamentEventUpdate
from app.tournament_errors import (
    DrawTypeFrozenError,
    EventNotFoundError,
    GroupSetFrozenError,
    NotTournamentOwnerError,
    TournamentNotFoundError,
)
from app.tournament_event_stages import mint_stages
from app.tournament_events import create_event, delete_event, update_event
from app.tournament_queries import stage_ids_for_events
from app.tournament_reservations import reservation_read
from tests._helpers import (
    counted_statements,
    event_groups,
    joined_to_reservation,
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
        # No ``id`` either: a reservation id is a server-minted uuid (ADR 20260801), so
        # the create shape has no field for one and sending one is a 422.
        "reservations": [
            {
                "name": "Reservation A",
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
        stages=mint_stages(DrawType.round_robin),
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
    # The reservations persisted as rows of their own, not as a value inside the event,
    # each with an id the SERVER minted (ADR 20260801) — the payload carried none.
    assert [group.reservation.name for group in event.groups] == ["Reservation A"]
    assert all(isinstance(group.id, uuid.UUID) for group in event.groups)
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


# ----- reservation positions -------------------------------------------------
#
# A group's ``position`` is the one field on it the client cannot author: it is not on
# the write shape at all (``ReservationWrite``), and the server stamps it from the
# reservation's index in the list that was sent — on BOTH verbs (ADR 20260801,
# "Reservations carry an explicit ``position``"). So there are two claims here, and
# they need each other:
#
#   * a payload that CARRIES a position is refused, naming the unknown field, rather
#     than having it silently overwritten. "Server-assigned" is then a property of the
#     schema, which a client can read, instead of a sentence in a docstring, which it
#     cannot; and
#   * a payload that does not is stored in the *order sent*, and nothing else. Every
#     reservation below is named so that alphabetical order is a DIFFERENT answer from
#     the order sent, which is what makes these able to fail — asserting "each
#     reservation has a position" would pass against an implementation that assigned
#     all zeros or sorted by name.


def _reservation(name: str, **extra: Any) -> dict[str, Any]:
    """One reservation payload, valid but for whatever ``extra`` the caller adds."""
    return {
        "name": name,
        "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
        "table_ids": ["t1"],
        **extra,
    }


def _named_positions(event: TournamentEvent) -> list[tuple[str, int]]:
    """``(name, position)`` per stored group, read off the ROWS in the relationship's
    order (which is ``position`` ascending).

    Names, not ids, because a reservation named "Reservation C" sitting at position 0
    is the whole claim: it is the reservation the director put first, and it is not the
    alphabetically first one. Read off the rows rather than through ``Reservation`` so a
    default the schema supplies could not stand in for a value the write path failed to
    store — and the names are what discriminate, since ordering by position cannot
    itself reveal whether the positions were stamped from the payload's order or from
    the reservations' names.
    """
    # The name is the RESERVATION's and the position is the GROUP's — the split the
    # projection reads back, spelled here against the rows.
    return [(group.reservation.name, group.position) for group in event.groups]


async def test_create_positions_reservations_by_the_order_they_were_sent(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """Three reservations sent as **C, A, B** are stored as positions 0, 1, 2 *in that
    order*.

    Sorted by name — or by id, which is how the order used to be recovered and which is
    now random — the answer would be C=2, A=0, B=1. Sorted by nothing at all it would
    be three zeros.
    The event's reservation order is the order the director sent, and this is the
    assertion that distinguishes the three.
    """
    owner = await make_user(db_session, "events-create-reservation-positions")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)

    event, _ = await create_event(
        db_session,
        tournament_id=tournament.id,
        actor=owner,
        payload=_event_payload(
            reservations=[
                _reservation("Reservation C"),
                _reservation("Reservation A"),
                _reservation("Reservation B"),
            ]
        ),
    )
    event_id = event.id

    assert _named_positions(event) == [
        ("Reservation C", 0),
        ("Reservation A", 1),
        ("Reservation B", 2),
    ]

    # Persisted, not merely returned — and read back off the row.
    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == event_id)
        )
    ).scalar_one()
    assert _named_positions(row) == [
        ("Reservation C", 0),
        ("Reservation A", 1),
        ("Reservation B", 2),
    ]
    # No two groups of one event share a position.
    positions = [group.position for group in row.groups]
    assert len(set(positions)) == len(positions)


_RESERVATIONS_CLAIMING_A_POSITION = [
    _reservation("Reservation C", position=7),
    _reservation("Reservation A", position=7),
    _reservation("Reservation B", position=7),
]
"""Three reservations that each claim position ``7`` — the payload a client writes when
it mistakes a server-assigned field for one of its own."""


@pytest.mark.parametrize(
    ("schema", "body"),
    [
        pytest.param(
            TournamentEventCreate,
            _event_body(reservations=_RESERVATIONS_CLAIMING_A_POSITION),
            id="create",
        ),
        pytest.param(
            TournamentEventUpdate,
            {"reservations": _RESERVATIONS_CLAIMING_A_POSITION},
            id="patch",
        ),
    ],
)
def test_a_write_payload_carrying_a_reservation_position_is_refused(
    schema: type[BaseModel], body: dict[str, Any]
) -> None:
    """A ``position`` on a reservation a client **sends** is an unknown field, on both
    verbs — refused by name, not accepted and quietly overwritten.

    ``position`` is not on ``ReservationWrite``, and both write schemas are
    ``extra="forbid"``, so this is the boundary saying "server-assigned" in the one
    register a client can actually read: the field is unsendable, so a client cannot
    believe it decided the order. The alternative — take it and ignore it — is the
    ``entered`` mistake in a different key: a value the caller watched itself send and
    the server watched itself discard, discoverable only in prose.

    Both verbs, because "the patch path is the hole" is this repo's recurring bug: the
    event editor PATCHes the whole form back, so the patch is the verb that would
    actually carry an echoed position. They share one alias (``EventReservations``) over
    one reservation shape, which is what makes that impossible to get wrong on only one
    of them.

    The **loc** is asserted, not just the refusal: a 422 that named ``reservations`` and
    nothing more would leave a client hunting through its own payload for a field it
    was never told about.
    """
    with pytest.raises(ValidationError) as refusal:
        schema.model_validate(body)

    errors = refusal.value.errors()
    # Every reservation that claimed one is named — not merely the first — so the
    # director's client can strip the field everywhere it put it, in one round trip.
    assert [error["loc"] for error in errors] == [
        ("reservations", 0, "position"),
        ("reservations", 1, "position"),
        ("reservations", 2, "position"),
    ]
    assert {error["type"] for error in errors} == {"extra_forbidden"}


async def test_update_repositions_reservations_by_the_order_they_were_patched(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The patch path is the other half of the same rule: the event is born C, A, B and
    patched to B, C, A, and its stored positions follow the payload.

    Guarding only ``create`` would leave the order to rot on the first edit — an event
    born with positions and then patched without them would silently fall back to
    whatever the ids happened to sort as, which is the exact failure the explicit
    position exists to end. The event is deliberately **un-drawn**, so the group-set
    freeze is not what is being tested here: the same three ids go in, re-ordered.
    """
    owner = await make_user(db_session, "events-update-reservation-positions")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event, _ = await create_event(
        db_session,
        tournament_id=tournament.id,
        actor=owner,
        payload=_event_payload(
            reservations=[
                _reservation("Reservation C"),
                _reservation("Reservation A"),
                _reservation("Reservation B"),
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
                "reservations": [
                    _reservation("Reservation B"),
                    _reservation("Reservation C"),
                    _reservation("Reservation A"),
                ]
            }
        ),
    )

    assert _named_positions(updated) == [
        ("Reservation B", 0),
        ("Reservation C", 1),
        ("Reservation A", 2),
    ]

    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == event_id)
        )
    ).scalar_one()
    assert _named_positions(row) == [
        ("Reservation B", 0),
        ("Reservation C", 1),
        ("Reservation A", 2),
    ]
    positions = [group.position for group in row.groups]
    assert len(set(positions)) == len(positions)


async def test_an_events_groups_and_reservations_are_rows_of_their_own(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A created event's groups and reservations are **rows in their own tables**, each
    carrying the window in the DATE/TIME columns the ADR pins (ADR 20260801, on what
    belongs to an event rather than to its draw settings) — and, since ADR 20260815,
    keyed by the event's stage 0 rather than the event directly, one hop the join below
    walks.

    Read with a **column-only** ``SELECT`` against the group/reservation (and stage)
    tables, not off ``event.groups``: the relationship would answer just as happily if
    the reservations were still a JSONB list on the event, and the claim here is
    precisely that they are not.

    The slot columns are asserted as real ``date``/``time`` VALUES rather than as
    strings, which is the same claim from the other side: a ``timestamptz`` column
    (api/CLAUDE.md's default rule, which the ADR deliberately excepts here) would read
    back as a ``datetime``, and this would fail on the type before the value.
    """
    owner = await make_user(db_session, "events-groups-are-rows")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)

    event, _ = await create_event(
        db_session,
        tournament_id=tournament.id,
        actor=owner,
        payload=_event_payload(
            reservations=[_reservation("Reservation A"), _reservation("Reservation B")]
        ),
    )
    event_id = event.id

    db_session.expire_all()
    rows = (
        await db_session.execute(
            # The name and the window live on the reservation, the id and the position
            # on the group: what the wire once served as one row is these two rows,
            # walked through the join that maps them.
            joined_to_reservation(
                select(
                    TournamentEventStage.event_id,
                    TournamentEventStageGroup.id,
                    TournamentEventReservation.name,
                    TournamentEventStageGroup.position,
                    TournamentEventReservation.slot_date,
                    TournamentEventReservation.slot_start,
                    TournamentEventReservation.slot_end,
                ).join(
                    TournamentEventStage,
                    TournamentEventStage.id == TournamentEventStageGroup.stage_id,
                )
            ).order_by(TournamentEventStageGroup.position)
        )
    ).all()

    # The ids are the server's (``gen_random_uuid()``), so what is asserted about them
    # is that they exist, are uuids, and are distinct — not their value, which no test
    # could spell.
    assert [(r[0], *r[2:]) for r in rows] == [
        (event_id, "Reservation A", 0, date(2026, 6, 13), time(9, 0), time(12, 30)),
        (event_id, "Reservation B", 1, date(2026, 6, 13), time(9, 0), time(12, 30)),
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
def test_a_reservation_window_the_columns_cannot_hold_is_refused(
    slot: dict[str, str], field: str
) -> None:
    """A reservation window that is not ``YYYY-MM-DD`` + ``HH:MM`` is a **422 at the
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
            _event_body(reservations=[_reservation("Reservation A", slot=slot)])
        )

    (error,) = refusal.value.errors()
    assert error["loc"] == ("reservations", 0, "slot"), field


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
    """An event carrying one group (named "Reservation A") AND a fixture — so
    ``event_has_draw`` is True and the two freezes are live. The fixture optionally
    carries a ``scheduled_start`` placement, for the timezone-reanchor path.

    The group's id is minted here (``event_groups``) rather than by the column's
    default, because the fixture below has to name it before either row is flushed."""
    stages = mint_stages(draw_type)
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
        stages=stages,
    )
    groups = event_groups(
        [
            {
                "name": "Reservation A",
                "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
                "table_ids": ["t1", "t2"],
            }
        ],
        event=event,
        tournament=tournament,
    )
    stages[0].groups = groups
    db.add(event)
    await db.commit()
    # Captured before ``db.refresh(event)`` below, which expires ``event.stages`` (a
    # genuinely LOADED collection — unlike the VIEWONLY ``event.groups``) along with it;
    # re-reading ``stages[0].id``/``groups[0].id`` afterward would be an async lazy load
    # on the now-expired child objects.
    stage0_id, group0_id = stages[0].id, groups[0].id
    await db.refresh(event)
    fixture = TournamentFixture(
        stage_id=stage0_id,
        group_id=group0_id,
        round=1,
        position=1,
        scheduled_start=scheduled_start,
    )
    db.add(fixture)
    await db.commit()
    return event


async def _add_cut_event_with_two_groups(
    db: AsyncSession, tournament: Tournament
) -> TournamentEvent:
    """An event carrying two groups ("Reservation A" at position 0, "Reservation B" at
    position 1), each with a fixture — so ``event_has_draw`` is True and, unlike
    :func:`_add_cut_event`'s single group, an *order* actually exists to change."""
    stages = mint_stages(DrawType.round_robin)
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Cut Singles",
        format=EventFormat.singles,
        draw_settings=TournamentEventDrawSettings.for_draw_type(DrawType.round_robin),
        max_players=None,
        entry_fee=Decimal("0.00"),
        timezone="America/Chicago",
        slot={"date": "2026-06-13", "start": "09:00", "end": "17:00"},
        match_settings={"rated": False, "length_games": 3},
        predicates=[],
        stages=stages,
    )
    groups = event_groups(
        [
            {
                "name": "Reservation A",
                "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
                "table_ids": ["t1"],
            },
            {
                "name": "Reservation B",
                "slot": {"date": "2026-06-13", "start": "13:00", "end": "16:30"},
                "table_ids": ["t2"],
            },
        ],
        event=event,
        tournament=tournament,
    )
    stages[0].groups = groups
    db.add(event)
    await db.commit()
    stage0_id = stages[0].id
    group_a_id, group_b_id = groups[0].id, groups[1].id
    await db.refresh(event)
    db.add_all(
        [
            TournamentFixture(
                stage_id=stage0_id, group_id=group_a_id, round=1, position=1
            ),
            TournamentFixture(
                stage_id=stage0_id, group_id=group_b_id, round=1, position=1
            ),
        ]
    )
    await db.commit()
    return event


async def test_update_event_frozen_group_reorder_is_refused(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """Once the draw is cut, a ``reservations`` payload citing exactly the reservations
    the event already has — the same set, in a **different order** — raises
    :class:`GroupSetFrozenError` and writes nothing, exactly as adding or removing one
    does (ADR-0786, extended).

    This is the regression pin for the mutable-``group_position`` bug: before this
    guard existed, ``_enforce_group_set_frozen`` compared only the group id SET, so a
    PATCH resending the same ids in a new order sailed through and restamped
    ``TournamentEventStageGroup.position`` (``apply_event_reservations``) — which is
    exactly what the qualifier seam labels a finished group's bracket seats by
    (``RrThenKoStrategy._qualifier_fills``'s ``group_position``). Between two groups
    finishing, that relabelling double-seats one group's qualifiers and strands
    another's — see ``tests/test_rr_then_ko.py``'s
    ``test_a_group_reorder_mid_draw_is_refused_and_seating_stays_correct`` for the
    end-to-end demonstration.

    The write payload's ``id`` names the **reservation's** id, not the group's — the
    wire keys the diff on the reservation now (``apply_event_reservations``) — so this
    reorder cites ``group_b.reservation.id`` / ``group_a.reservation.id``, swapped.
    """
    owner = await make_user(db_session, "events-update-groupreorder-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _add_cut_event_with_two_groups(db_session, tournament)
    event_id = event.id
    (group_a, group_b) = sorted(event.groups, key=lambda group: group.position)

    updates = TournamentEventUpdate.model_validate(
        {
            "name": "Should Not Apply",
            "reservations": [
                {
                    "id": str(group_b.reservation.id),
                    "name": group_b.reservation.name,
                    "slot": {"date": "2026-06-13", "start": "13:00", "end": "16:30"},
                    "table_ids": [],
                },
                {
                    "id": str(group_a.reservation.id),
                    "name": group_a.reservation.name,
                    "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
                    "table_ids": [],
                },
            ],
        }
    )
    with pytest.raises(GroupSetFrozenError) as excinfo:
        await update_event(
            db_session,
            tournament_id=tournament.id,
            event_id=event_id,
            actor=owner,
            updates=updates,
        )
    assert "order of its groups is frozen" in str(excinfo.value)
    # A reorder gains and loses nothing — the set is identical, only the sequence moved.
    # ``added`` is a COUNT, not a list of labels: an added group's label derives from a
    # position this very payload rewrites, so naming it would collide with an existing
    # group's (see ``_group_set_frozen_detail``).
    assert excinfo.value.removed == []
    assert excinfo.value.added == 0

    # Refused before the setattr loop: neither the groups' order nor the name changed.
    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == event_id)
        )
    ).scalar_one()
    assert row.name == "Cut Singles"
    assert [group.reservation.name for group in row.groups] == [
        "Reservation A",
        "Reservation B",
    ]


async def test_update_event_re_sending_the_same_group_order_is_not_frozen(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """Re-sending the reservations an event already has, in the order it already has
    them, changes nothing, so it is NOT refused even with a cut draw — the case the
    freeze exists to permit, and the sibling of the same-draw-type test above."""
    owner = await make_user(db_session, "events-update-groupsameorder-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _add_cut_event_with_two_groups(db_session, tournament)
    event_id = event.id
    (group_a, group_b) = sorted(event.groups, key=lambda group: group.position)

    updated, league_id = await update_event(
        db_session,
        tournament_id=tournament.id,
        event_id=event_id,
        actor=owner,
        updates=TournamentEventUpdate.model_validate(
            {
                "name": "Renamed Under Draw",
                "reservations": [
                    {
                        "id": str(group_a.reservation.id),
                        "name": group_a.reservation.name,
                        "slot": {
                            "date": "2026-06-13",
                            "start": "09:00",
                            "end": "12:30",
                        },
                        "table_ids": [],
                    },
                    {
                        "id": str(group_b.reservation.id),
                        "name": group_b.reservation.name,
                        "slot": {
                            "date": "2026-06-13",
                            "start": "13:00",
                            "end": "16:30",
                        },
                        "table_ids": [],
                    },
                ],
            }
        ),
    )

    assert league_id == default_league.id
    assert updated.name == "Renamed Under Draw"
    assert [group.reservation.name for group in updated.groups] == [
        "Reservation A",
        "Reservation B",
    ]


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


async def test_update_event_frozen_group_set_change_is_refused(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """Once the draw is cut, a ``reservations`` payload that changes *which groups* the
    event has raises :class:`GroupSetFrozenError` and writes nothing (ADR-0786)."""
    owner = await make_user(db_session, "events-update-groupfreeze-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _add_cut_event(db_session, tournament)
    event_id = event.id

    updates = TournamentEventUpdate.model_validate(
        {
            "name": "Should Not Apply",
            "reservations": [
                {
                    "name": "Reservation B",
                    "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
                    "table_ids": ["t1"],
                }
            ],
        }
    )
    with pytest.raises(GroupSetFrozenError):
        await update_event(
            db_session,
            tournament_id=tournament.id,
            event_id=event_id,
            actor=owner,
            updates=updates,
        )

    # Refused before the setattr loop: neither the groups nor the name were written.
    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == event_id)
        )
    ).scalar_one()
    assert row.name == "Cut Singles"
    assert [group.reservation.name for group in row.groups] == ["Reservation A"]


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
            select(TournamentFixture).where(
                TournamentFixture.stage_id.in_(stage_ids_for_events([event_id]))
            )
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


# ----- a reservation's table reservations (ADR 20260801) --------------------
#
# The tables a reservation reserves are rows now —
# ``tournament_event_reservation_tables`` — where they were a JSONB array of strings
# that could name anything at all. Three claims live down here, and only the first is
# visible through the wire shape:
#
#   * a reservation round-trips through rows, in the order it was sent;
#   * a reservation cannot reserve **another tournament's** table, and it is the
#     DATABASE that says so — the two spellings of that illegal state are refused by
#     two different legs of the same three-legged key;
#   * removing a table takes the reservations that named it, quietly, because a
#     reservation is a preference and only a placement is a commitment.

#: The leg that catches a reservation naming a table of a tournament other than the one
#: the row claims to be inside.
RESERVATION_TABLE_TABLE_CONSTRAINT = (
    "fk_tournament_event_reservation_tables_tournament_id_table_id"
)
#: The leg that catches a reservation whose claimed tournament is not the one its
#: event belongs to — the one that looks redundant and is not (see the model).
RESERVATION_TABLE_EVENT_CONSTRAINT = (
    "fk_tournament_event_reservation_tables_tournament_id_event_id"
)


async def _reservation_rows(
    db: AsyncSession, event_id: uuid.UUID
) -> list[tuple[uuid.UUID, uuid.UUID, str, int]]:
    """``(tournament_id, reservation_id, table_id, position)`` per stored reservation of
    this event, in reservation then position order.

    A column-only ``SELECT`` so it reads the rows and not the session's opinion of them:
    two of the tests below delete rows out from under loaded ORM instances (that is the
    behaviour under test), and a collection read off those instances would answer with
    what the session last saw.
    """
    return [
        (tournament_id, reservation_id, table_id, position)
        for tournament_id, reservation_id, table_id, position in (
            await db.execute(
                select(
                    TournamentEventReservationTable.tournament_id,
                    TournamentEventReservationTable.reservation_id,
                    TournamentEventReservationTable.table_id,
                    TournamentEventReservationTable.position,
                )
                .where(TournamentEventReservationTable.event_id == event_id)
                .order_by(
                    TournamentEventReservationTable.reservation_id,
                    TournamentEventReservationTable.position,
                )
            )
        ).all()
    ]


def _reservation_payload(
    *table_ids: str, name: str = "Reservation A"
) -> dict[str, Any]:
    """One reservation reserving exactly ``table_ids``, in that order."""
    return {
        "name": name,
        "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
        "table_ids": list(table_ids),
    }


async def test_a_reservations_tables_are_stored_as_rows_in_the_order_they_were_sent(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A reservation reserves its tables through **rows**, not a string array — and the
    wire shape is unchanged, because ``table_ids`` is composed back from them.

    The two tables are named in *reverse* catalogue order, which is what makes this able
    to fail: rows have no inherent order, and reading them back by ``table_id`` (a
    random uuid) or by insertion happenstance would give the director's list back
    shuffled. ``position`` is what carries the order the payload stated, exactly as it
    does for the reservations themselves and for the venue catalogue.
    """
    owner = await make_user(db_session, "events-reservation-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id
    table_1, table_2 = [str(table.id) for table in tournament.tables]

    event, _ = await create_event(
        db_session,
        tournament_id=tournament_id,
        actor=owner,
        payload=_event_payload(reservations=[_reservation_payload(table_2, table_1)]),
    )
    event_id = event.id
    reservation_id = event.groups[0].reservation.id

    # Rows, carrying the denormalized tournament and the order sent.
    db_session.expire_all()
    assert await _reservation_rows(db_session, event_id) == [
        (tournament_id, reservation_id, table_2, 0),
        (tournament_id, reservation_id, table_1, 1),
    ]
    # And the same order back through the read shape everything above the database uses.
    stored = (
        await db_session.execute(
            select(TournamentEventReservation).where(
                TournamentEventReservation.id == reservation_id
            )
        )
    ).scalar_one()
    assert reservation_read(stored).table_ids == [table_2, table_1]


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
        payload=_event_payload(
            reservations=[_reservation_payload(mine, foreign_table)]
        ),
    )
    event_id = event.id
    reservation_id = event.groups[0].reservation.id

    db_session.expire_all()
    assert await _reservation_rows(db_session, event_id) == [
        (tournament_id, reservation_id, mine, 0)
    ]


async def test_a_reservations_table_across_tournaments_is_refused_by_the_database(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The claim the composite foreign keys exist to make (ADR 20260801): a reservation
    cannot reserve another tournament's table — and it is the **database** that says so,
    not the write path above it.

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

    Both are refused at the INSERT: unlike the fixture's ``(event_id, group_id)``, none
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
        payload=_event_payload(reservations=[_reservation_payload()]),
    )
    event_id = event.id
    reservation_id = event.groups[0].reservation.id
    db_session.add(
        TournamentEventReservationTable(
            tournament_id=tournament_id,
            event_id=event_id,
            reservation_id=reservation_id,
            table_id=foreign_table,
            position=0,
        )
    )
    with pytest.raises(IntegrityError) as excinfo:
        await db_session.commit()
    assert RESERVATION_TABLE_TABLE_CONSTRAINT in str(excinfo.value)
    await db_session.rollback()

    db_session.add(
        TournamentEventReservationTable(
            tournament_id=other_id,
            event_id=event_id,
            reservation_id=reservation_id,
            table_id=foreign_table,
            position=0,
        )
    )
    with pytest.raises(IntegrityError) as excinfo:
        await db_session.commit()
    assert RESERVATION_TABLE_EVENT_CONSTRAINT in str(excinfo.value)
    await db_session.rollback()

    # Neither refusal left anything behind.
    assert await _reservation_rows(db_session, event_id) == []


async def test_a_reservation_naming_no_table_at_all_is_refused_by_the_database(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The plainer half of the same key: a ``table_id`` naming no table anywhere.

    It was storable for as long as a reservation's tables were strings in a JSONB array
    — the dangling reference ADR-0790 could only shrug at, and the reason "this id names
    a table" had to be re-derived by every reader. It is a foreign-key violation now."""
    owner = await make_user(db_session, "events-dangling-reservation-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id
    event, _ = await create_event(
        db_session,
        tournament_id=tournament_id,
        actor=owner,
        payload=_event_payload(reservations=[_reservation_payload()]),
    )

    db_session.add(
        TournamentEventReservationTable(
            tournament_id=tournament_id,
            event_id=event.id,
            reservation_id=event.groups[0].reservation.id,
            table_id=str(uuid.uuid4()),
            position=0,
        )
    )
    with pytest.raises(IntegrityError) as excinfo:
        await db_session.commit()
    assert RESERVATION_TABLE_TABLE_CONSTRAINT in str(excinfo.value)
    await db_session.rollback()


async def test_removing_a_table_drops_the_reservations_that_named_it(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """Deleting a venue table takes the reservations naming it — and only those — with
    no error and no ceremony.

    This is the ADR's asymmetry, from the reservation's side. A fixture *placed* at a
    table blocks the delete (``ON DELETE RESTRICT``) so the director can be asked; a
    reservation that merely *reserves* it is not consulted, because a table breaking or
    freeing up is ordinary venue traffic and the reservation simply reserves one fewer.
    Under the JSONB array the reservation went on listing the dead id forever; the
    CASCADE is what makes "reserves one fewer" true in the database rather than derived
    by every reader.

    Deleted at the row, deliberately, rather than through the tournament-edit verb: this
    is a claim about the constraint, and the verb's own 409/opt-in path is pinned in
    ``test_tournaments.py``. The surviving reservation is asserted too — a cascade that
    took the whole reservation's tables would satisfy "the dead one is gone".
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
        payload=_event_payload(reservations=[_reservation_payload(table_1, table_2)]),
    )
    event_id = event.id
    # Two ids, because the row that holds the table and the row a client cites are
    # different rows now: the reservation carries the tables, the group carries the
    # identity the wire serves.
    group_id = event.groups[0].id
    reservation_id = event.groups[0].reservation.id

    await db_session.delete(doomed)
    await db_session.commit()

    db_session.expire_all()
    assert await _reservation_rows(db_session, event_id) == [
        (tournament_id, reservation_id, table_1, 0)
    ]
    # The group itself is untouched — a reservation's table went, not the group.
    assert (
        await db_session.execute(
            select(TournamentEventStageGroup.id).where(
                TournamentEventStageGroup.stage_id.in_(stage_ids_for_events([event_id]))
            )
        )
    ).scalars().all() == [group_id]


async def test_removing_a_reservation_takes_its_table_reservations_with_it(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A reservation dropped from a PATCH takes its table rows with it, through the same
    ``delete-orphan``/CASCADE pair the reservation itself goes by — so no table row
    outlives the reservation that made it."""
    owner = await make_user(db_session, "events-reservation-cascade-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id
    table_1, _table_2 = [str(table.id) for table in tournament.tables]
    event, _ = await create_event(
        db_session,
        tournament_id=tournament_id,
        actor=owner,
        payload=_event_payload(reservations=[_reservation_payload(table_1)]),
    )
    event_id = event.id

    await update_event(
        db_session,
        tournament_id=tournament_id,
        event_id=event_id,
        actor=owner,
        updates=TournamentEventUpdate.model_validate({"reservations": []}),
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
    first), so re-sending a table the reservation already reserves would die on
    ``pk_tournament_event_reservation_tables``. And swapping two reservations moves one
    onto a ``position`` the other has not vacated yet, which is why the uniqueness on
    ``(event_id, reservation_id, position)`` is ``DEFERRABLE INITIALLY DEFERRED`` —
    checked immediately it would refuse a transaction whose end state is perfectly
    unique.

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
        payload=_event_payload(reservations=[_reservation_payload(table_1, table_2)]),
    )
    event_id = event.id
    reservation_id = event.groups[0].reservation.id
    created_at = (
        await db_session.execute(
            select(TournamentEventReservationTable.created_at).where(
                TournamentEventReservationTable.event_id == event_id,
                TournamentEventReservationTable.table_id == table_1,
            )
        )
    ).scalar_one()

    await update_event(
        db_session,
        tournament_id=tournament_id,
        event_id=event_id,
        actor=owner,
        updates=TournamentEventUpdate.model_validate(
            # The reservation is CITED by the id the server minted, so the diff keeps
            # its row — which is the whole premise of the claim below about its tables.
            {
                "reservations": [
                    {
                        **_reservation_payload(table_2, table_1),
                        "id": str(reservation_id),
                    }
                ]
            }
        ),
    )

    db_session.expire_all()
    assert await _reservation_rows(db_session, event_id) == [
        (tournament_id, reservation_id, table_2, 0),
        (tournament_id, reservation_id, table_1, 1),
    ]
    assert (
        await db_session.execute(
            select(TournamentEventReservationTable.created_at).where(
                TournamentEventReservationTable.event_id == event_id,
                TournamentEventReservationTable.table_id == table_1,
            )
        )
    ).scalar_one() == created_at


# The round trips ONE reservations PATCH costs, over the whole `update_event` verb: the
# tournament and its catalogue, the event, the freeze check's read of the current
# groups, the stage-0 load the diff is written against, and the event's reservations.
#
# It exists because nothing else pins the WRITE path. The three sibling tripwires
# (`EXPECTED_TOURNAMENT_LIST_STATEMENTS`, `EXPECTED_TOURNAMENT_DETAIL_STATEMENTS`,
# `EXPECTED_DASHBOARD_PANEL_STATEMENTS`) all count a page READ, so a loader mistake on
# this verb costs real round trips and leaves every one of them green. Splitting the
# one row into a group and a reservation did exactly that, twice, and both were
# invisible:
#
#   * an explicit `selectinload` chain spelled down to the reservation's tables, which
#     OVERRODE the `lazy="joined"` those one-to-one legs declare and turned each into
#     its own statement; and
#   * a throwaway `select(TournamentEvent)` issued purely so a loader option would
#     populate `event.reservations`, re-reading a row already in the session.
#
# Together they cost 7 statements on every reservations PATCH.
# `app.tournament_reservations` is the one write seam, so one number here covers the
# whole verb.
#
# It is not a count that must never move — a real change to what the verb does may move
# it. It is a count that must never move BY ACCIDENT. If it changes, say why in the
# same commit.
EXPECTED_RESERVATION_WRITE_STATEMENTS = 15


async def test_reservation_write_statement_count_does_not_drift(
    db_session: AsyncSession,
    engine: AsyncEngine,
    default_league: League,
) -> None:
    """A reservations PATCH costs a fixed number of round trips, whatever the loader
    graph underneath it happens to look like.

    Two reservations, both CITED by id, so this exercises the update arm of the
    id-keyed diff — the arm that re-times and re-tables an existing reservation, and
    therefore the one that has to have the whole group -> join -> reservation -> tables
    chain in hand. An add-only or remove-only payload would touch less of it.

    The cited id is the **reservation's**, not the group's: the wire's writable array is
    ``reservations``, and the diff keys on the id a client can actually name.

    Counted around the verb rather than the HTTP request, matching the sibling read
    tripwires: an endpoint-level count would also sweep up session and auth statements
    that have nothing to do with this loader graph.
    """
    owner = await make_user(db_session, "events-write-count-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id
    event, _ = await create_event(
        db_session,
        tournament_id=tournament_id,
        actor=owner,
        payload=_event_payload(
            reservations=[_reservation("Reservation A"), _reservation("Reservation B")]
        ),
    )
    event_id = event.id
    reservation_ids = [group.reservation.id for group in event.groups]
    await db_session.commit()

    async with counted_statements(engine) as (session, statements):
        await update_event(
            session,
            tournament_id=tournament_id,
            event_id=event_id,
            actor=owner,
            updates=TournamentEventUpdate.model_validate(
                {
                    "reservations": [
                        {
                            **_reservation("Reservation A"),
                            "id": str(reservation_ids[0]),
                        },
                        {
                            **_reservation("Reservation B"),
                            "id": str(reservation_ids[1]),
                        },
                    ]
                }
            ),
        )

    selects = [s for s in statements if s.strip().upper().startswith("SELECT")]
    assert len(selects) == EXPECTED_RESERVATION_WRITE_STATEMENTS, selects
