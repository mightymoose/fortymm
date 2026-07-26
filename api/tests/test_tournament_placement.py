"""Service-layer tests for the transport-neutral fixture-placement verb.

These drive ``app.tournament_placement.place_fixture`` directly with a raw
``db_session`` and no FastAPI — proving the write path (the owner-load, the fixture
load, the freeze, the pin/notify transition, the commit and read-back) runs, persists,
and signals every refusal with a **domain exception** from ``app.tournament_errors``
rather than an ``HTTPException``. The HTTP wire contract those exceptions map back to is
pinned by the unchanged endpoint tests in ``test_tournaments.py``; this file is the
branch matrix behind them.

The matrix is exactly: an owner places a fixture (the columns take effect and the full
placement silently pins pre-live), a non-owner is refused
(:class:`NotTournamentOwnerError`), an absent tournament is a not-found
(:class:`TournamentNotFoundError`), an absent/cross-tournament fixture is a not-found
(:class:`FixtureNotFoundError`), and a played-out fixture's placement is frozen
(:class:`FixturePlacementFrozenError`) — the one hard rule of an otherwise-soft
endpoint (ADR-0790).
"""

import uuid
from datetime import datetime
from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    DrawType,
    EventFormat,
    League,
    Match,
    MatchSettings,
    MatchStatus,
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentFixture,
    TournamentStatus,
    User,
)
from app.schemas.tournament import TournamentFixturePlacementUpdate
from app.tournament_errors import (
    FixtureNotFoundError,
    FixturePlacementFrozenError,
    NotTournamentOwnerError,
    TournamentNotFoundError,
)
from app.tournament_placement import place_fixture
from tests._helpers import make_user


async def _seed_placeable_fixture(
    db: AsyncSession,
    owner: User,
    league: League,
    *,
    status: TournamentStatus = TournamentStatus.draft,
) -> tuple[Tournament, TournamentEvent, TournamentFixture]:
    """A tournament owned by ``owner`` with one singles event and one fixture seating
    two active entrants — written straight to the database, the state the place verb's
    load path expects. The ``table_catalogue`` carries ``t1``/``t2`` so a placement can
    name a real table, and the event's pool ``p-os-1`` anchors the fixture."""
    tournament = Tournament(
        name="Placement Cup",
        address={
            "venue": "Berkeley TT Club",
            "street": "2727 Milvia St",
            "city": "Berkeley",
            "region": "CA",
            "postal": "94703",
            "country": "USA",
            "latitude": 37.8703,
            "longitude": -122.2731,
        },
        table_catalogue=[
            {"id": "t1", "label": "Table 1", "court": "A"},
            {"id": "t2", "label": "Table 2", "court": "A"},
        ],
        league_id=league.id,
        created_by_user_id=owner.id,
        status=status,
    )
    db.add(tournament)
    await db.commit()
    await db.refresh(tournament)
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Open Singles",
        format=EventFormat.singles,
        draw_type=DrawType.round_robin,
        max_players=64,
        entry_fee=Decimal("45"),
        timezone="America/Chicago",
        slot={"date": "2026-06-13", "start": "09:00", "end": "18:00"},
        match_settings={"rated": True, "length_games": 5},
        predicates=[],
        pools=[
            {
                "id": "p-os-1",
                "name": "Pool A",
                "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
                "table_ids": ["t1"],
            }
        ],
    )
    db.add(event)
    await db.commit()
    await db.refresh(event)
    entry_a = TournamentEntry(
        event_id=event.id,
        user_id=(await make_user(db, "place-a-" + uuid.uuid4().hex)).id,
        status=TournamentEntryStatus.entered,
    )
    entry_b = TournamentEntry(
        event_id=event.id,
        user_id=(await make_user(db, "place-b-" + uuid.uuid4().hex)).id,
        status=TournamentEntryStatus.entered,
    )
    db.add_all([entry_a, entry_b])
    await db.commit()
    fixture = TournamentFixture(
        event_id=event.id,
        pool_id="p-os-1",
        round=1,
        position=1,
        entry_a_id=entry_a.id,
        entry_b_id=entry_b.id,
    )
    db.add(fixture)
    await db.commit()
    await db.refresh(fixture)
    return tournament, event, fixture


def _placement(
    table_id: str | None, scheduled_start: datetime | None
) -> TournamentFixturePlacementUpdate:
    """A placement body, validated through the same schema the HTTP route parses."""
    return TournamentFixturePlacementUpdate(
        table_id=table_id, scheduled_start=scheduled_start
    )


async def test_owner_places_a_fixture_and_the_columns_take_effect(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The owner sets a full placement (table + naive wall-clock start): the returned
    read carries both, and the persisted fixture row records them — and, because a full
    placement of a known-entrant fixture is a pin, ``pinned_at`` is set (silently, since
    the tournament is a pre-live draft)."""
    owner = await make_user(db_session, "place-owner")
    tournament, event, fixture = await _seed_placeable_fixture(
        db_session, owner, default_league
    )
    fixture_id = fixture.id

    read = await place_fixture(
        db_session,
        tournament_id=tournament.id,
        fixture_id=fixture_id,
        actor=owner,
        placement=_placement("t1", datetime(2026, 6, 13, 10, 0)),
    )

    assert read.id == fixture_id
    assert read.table_id == "t1"
    assert read.scheduled_start is not None

    # The columns are durable, and the full placement pinned the fixture.
    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentFixture).where(TournamentFixture.id == fixture_id)
        )
    ).scalar_one()
    assert row.table_id == "t1"
    assert row.scheduled_start is not None
    assert row.pinned_at is not None


async def test_non_owner_cannot_place_a_fixture(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A caller who is not the tournament's creator is refused with
    :class:`NotTournamentOwnerError` — owner-gated by construction — and the fixture is
    left unplaced (no columns, no pin)."""
    owner = await make_user(db_session, "place-guard-owner")
    stranger = await make_user(db_session, "place-stranger")
    tournament, _event, fixture = await _seed_placeable_fixture(
        db_session, owner, default_league
    )
    fixture_id = fixture.id

    with pytest.raises(NotTournamentOwnerError):
        await place_fixture(
            db_session,
            tournament_id=tournament.id,
            fixture_id=fixture_id,
            actor=stranger,
            placement=_placement("t1", datetime(2026, 6, 13, 10, 0)),
        )

    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentFixture).where(TournamentFixture.id == fixture_id)
        )
    ).scalar_one()
    assert row.table_id is None
    assert row.scheduled_start is None
    assert row.pinned_at is None


async def test_absent_tournament_is_a_not_found(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """An id that names no tournament raises :class:`TournamentNotFoundError` — the 404
    judged before the fixture is even looked at (the locked owner-load runs first)."""
    owner = await make_user(db_session, "place-absent-tournament")

    with pytest.raises(TournamentNotFoundError):
        await place_fixture(
            db_session,
            tournament_id=uuid.uuid4(),
            fixture_id=uuid.uuid4(),
            actor=owner,
            placement=_placement(None, None),
        )


async def test_a_fixture_not_under_the_tournament_is_a_not_found(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The fixture is scoped by BOTH ids: a fixture id that names nothing, and a real
    fixture that belongs to a *different* tournament addressed through this one, are
    each a :class:`FixtureNotFoundError` — not a cross-tournament placement
    (ADR-0790)."""
    owner = await make_user(db_session, "place-scope-owner")
    tournament, _event, _fixture = await _seed_placeable_fixture(
        db_session, owner, default_league
    )
    # A second tournament (same owner) whose fixture must not be addressable through the
    # first tournament's id.
    _other_t, _other_e, foreign = await _seed_placeable_fixture(
        db_session, owner, default_league
    )
    tournament_id = tournament.id
    foreign_id = foreign.id

    # A fixture id that names nothing at all.
    with pytest.raises(FixtureNotFoundError):
        await place_fixture(
            db_session,
            tournament_id=tournament_id,
            fixture_id=uuid.uuid4(),
            actor=owner,
            placement=_placement(None, None),
        )
    # A real fixture, but of the OTHER tournament, addressed through this one.
    with pytest.raises(FixtureNotFoundError):
        await place_fixture(
            db_session,
            tournament_id=tournament_id,
            fixture_id=foreign_id,
            actor=owner,
            placement=_placement(None, None),
        )


@pytest.mark.parametrize("frozen_status", [MatchStatus.completed, MatchStatus.voided])
async def test_a_played_out_fixture_refuses_the_placement(
    db_session: AsyncSession,
    default_league: League,
    frozen_status: MatchStatus,
) -> None:
    """The one hard rule (ADR-0790): a fixture whose linked match is ``completed`` or
    ``voided`` is history, so a placement is refused with
    :class:`FixturePlacementFrozenError` — carrying the match status the adapter names —
    and nothing is written. ``in_progress`` is NOT a freeze trigger, so only these two
    terminal statuses reach here."""
    owner = await make_user(db_session, "place-frozen-owner")
    tournament, _event, fixture = await _seed_placeable_fixture(
        db_session, owner, default_league
    )
    fixture_id = fixture.id
    match = Match(
        match_settings=MatchSettings(team_size=1, best_of=5, affects_rating=False),
        league_id=default_league.id,
        created_by_user_id=owner.id,
    )
    match.status = frozen_status
    db_session.add(match)
    await db_session.commit()
    fixture.match_id = match.id
    await db_session.commit()

    with pytest.raises(FixturePlacementFrozenError) as exc_info:
        await place_fixture(
            db_session,
            tournament_id=tournament.id,
            fixture_id=fixture_id,
            actor=owner,
            placement=_placement("t1", datetime(2026, 6, 13, 10, 0)),
        )
    assert exc_info.value.match_status == frozen_status.value

    # The refusal wrote nothing: the fixture stays unplaced.
    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentFixture).where(TournamentFixture.id == fixture_id)
        )
    ).scalar_one()
    assert row.table_id is None
    assert row.scheduled_start is None
    assert row.pinned_at is None
