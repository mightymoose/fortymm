"""Service-layer tests for the transport-neutral cut / un-cut draw verbs.

These drive ``app.tournament_draw_service.cut_event_draw`` /
``uncut_event_draw`` directly with a raw ``db_session`` and no FastAPI — proving
the write path (row-locked owner gate, event-under-tournament load, play-evidence
gate, the ``cut_draw`` / ``uncut_draw`` core) runs, persists, and signals every
refusal with a **domain exception** from ``app.tournament_errors`` (or lets the
``app.draws.DrawError`` family propagate unchanged) rather than an
``HTTPException``. The HTTP wire contract those exceptions map back to is pinned
by the unchanged endpoint tests in ``test_tournaments.py`` (``-k draw``); this
file is the branch matrix behind them.
"""

import uuid
from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.draws import NonSinglesDraw, UnsupportedDrawType
from app.models import (
    League,
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentFixture,
    TournamentStatus,
    User,
)
from app.models.tournament import DrawType, EventFormat
from app.tournament_draw_service import cut_event_draw, uncut_event_draw
from app.tournament_errors import (
    DrawUnderWayError,
    EventNotFoundError,
    NotTournamentOwnerError,
    TournamentNotFoundError,
)
from tests._helpers import make_user

# Two pools, so the snake has somewhere to snake to and a fixture's ``pool_id`` is a
# ref that resolves against the right one — the same shape ``test_tournaments.py``'s
# draw tests cut across.
POOL_A: dict[str, object] = {
    "id": "p-a",
    "name": "Pool A",
    "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
    "table_ids": ["t1"],
}
POOL_B: dict[str, object] = {
    "id": "p-b",
    "name": "Pool B",
    "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
    "table_ids": ["t2"],
}


async def _make_tournament(
    db: AsyncSession,
    *,
    owner: User,
    league: League,
) -> Tournament:
    tournament = Tournament(
        name="Bay Area Open 2026",
        description="Two-day open.",
        address={
            "venue": "Berkeley TT Club",
            "street": "2727 Milvia St",
            "city": "Berkeley",
            "region": "CA",
            "postal": "94703",
            "country": "USA",
        },
        table_catalogue=[
            {"id": "t1", "label": "Table 1", "court": "A"},
            {"id": "t2", "label": "Table 2", "court": "A"},
        ],
        league_id=league.id,
        created_by_user_id=owner.id,
        status=TournamentStatus.draft,
    )
    db.add(tournament)
    await db.commit()
    await db.refresh(tournament)
    return tournament


async def _make_event(
    db: AsyncSession,
    tournament: Tournament,
    *,
    format: EventFormat = EventFormat.singles,
    draw_type: DrawType = DrawType.round_robin,
    pools: list[dict[str, object]] | None = None,
) -> TournamentEvent:
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Open Singles",
        format=format,
        draw_type=draw_type,
        max_players=64,
        entry_fee=Decimal("45"),
        slot={"date": "2026-06-13", "start": "09:00", "end": "18:00"},
        match_settings={"rated": True, "length_games": 5},
        predicates=[],
        pools=[POOL_A, POOL_B] if pools is None else pools,
    )
    db.add(event)
    await db.commit()
    await db.refresh(event)
    return event


async def _enter_field(
    db: AsyncSession, event: TournamentEvent, count: int, *, prefix: str
) -> list[TournamentEntry]:
    """``count`` active, seeded (1..N) entrants — enough for the round-robin snake to
    deal a clean draw across the two pools."""
    entries = [
        TournamentEntry(
            event_id=event.id,
            user_id=(await make_user(db, f"{prefix}{n}")).id,
            status=TournamentEntryStatus.entered,
            seed=n,
        )
        for n in range(1, count + 1)
    ]
    db.add_all(entries)
    await db.commit()
    return entries


async def _fixture_rows(
    db: AsyncSession, event_id: uuid.UUID
) -> list[TournamentFixture]:
    db.expire_all()
    return list(
        (
            await db.execute(
                select(TournamentFixture).where(TournamentFixture.event_id == event_id)
            )
        )
        .scalars()
        .all()
    )


# ----- the owner cuts a singles event: fixtures are created + persisted ------


async def test_owner_cut_creates_and_persists_fixtures(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    owner = await make_user(db_session, "owner-cut")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    # Capture PKs before the verb commits — the commit expires the ORM objects, so
    # reading their ids afterwards would trigger a sync lazy-load in async land.
    tournament_id, event_id = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="cut")
    await db_session.refresh(owner)

    result = await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )

    # Four singles over two pools: 2 apiece, one round-robin fixture in each pool.
    assert len(result) == 2
    rows = await _fixture_rows(db_session, event_id)
    # The verb answers with the persisted draw — same rows, same ids.
    assert {f.id for f in result} == {r.id for r in rows}
    # Every fixture seats two known entrants, none played.
    assert all(
        r.entry_a_id is not None
        and r.entry_b_id is not None
        and r.winner_entry_id is None
        and r.match_id is None
        for r in rows
    )


# ----- a re-cut on a drawn-but-unplayed event replaces wholesale -------------


async def test_recut_of_an_unplayed_draw_replaces_wholesale(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    owner = await make_user(db_session, "owner-recut")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    tournament_id, event_id = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="recut")

    await db_session.refresh(owner)
    first = await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    first_ids = {f.id for f in first}

    await db_session.refresh(owner)
    second = await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    second_ids = {f.id for f in second}

    # Wholesale, not a reconcile: the old rows were deleted and a fresh set minted,
    # so no id survives, and the event holds exactly the second draw.
    assert first_ids.isdisjoint(second_ids)
    rows = await _fixture_rows(db_session, event_id)
    assert {r.id for r in rows} == second_ids


# ----- evidence of play refuses both a re-cut and an un-cut ------------------


@pytest.mark.parametrize("verb", [cut_event_draw, uncut_event_draw])
async def test_a_played_draw_refuses_recut_and_uncut(
    db_session: AsyncSession,
    default_league: League,
    verb: object,
) -> None:
    owner = await make_user(db_session, "owner-played")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    tournament_id, event_id = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="played")

    await db_session.refresh(owner)
    await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )

    # Record a winner on one fixture — evidence of play (``draw_has_play``): a re-cut
    # or an un-cut would throw away a result a player produced.
    rows = await _fixture_rows(db_session, event_id)
    rows[0].winner_entry_id = rows[0].entry_a_id
    await db_session.commit()
    before = {r.id for r in await _fixture_rows(db_session, event_id)}

    await db_session.refresh(owner)
    with pytest.raises(DrawUnderWayError):
        await verb(  # type: ignore[operator]  # parametrized over the two verbs
            db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
        )

    # The refusal is asked before anything is deleted, so the standing draw is intact.
    assert {r.id for r in await _fixture_rows(db_session, event_id)} == before


# ----- an event that cannot produce a draw raises the DrawError family -------


async def test_a_non_singles_event_raises_non_singles_draw(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    owner = await make_user(db_session, "owner-doubles")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament, format=EventFormat.doubles)
    tournament_id, event_id = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="doubles")

    await db_session.refresh(owner)
    with pytest.raises(NonSinglesDraw):
        await cut_event_draw(
            db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
        )

    # Refused before the DELETE, so nothing was written.
    assert await _fixture_rows(db_session, event_id) == []


async def test_an_unimplemented_draw_type_raises_unsupported_draw_type(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    owner = await make_user(db_session, "owner-rrko")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    # ``rr-then-ko`` has no generator today (ADR-0786): the strategy is chosen before
    # the field is read, so this is refused whatever the entrants.
    event = await _make_event(db_session, tournament, draw_type=DrawType.rr_then_ko)
    tournament_id, event_id = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="rrko")

    await db_session.refresh(owner)
    with pytest.raises(UnsupportedDrawType):
        await cut_event_draw(
            db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
        )

    assert await _fixture_rows(db_session, event_id) == []


# ----- un-cut removes the fixtures -------------------------------------------


async def test_uncut_removes_the_fixtures(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    owner = await make_user(db_session, "owner-uncut")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    tournament_id, event_id = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="uncut")

    await db_session.refresh(owner)
    await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    assert await _fixture_rows(db_session, event_id) != []

    await db_session.refresh(owner)
    result = await uncut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )

    assert result is None
    assert await _fixture_rows(db_session, event_id) == []


async def test_uncut_of_a_never_cut_draw_is_a_no_op(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """An event with no draw is already in the state the un-cut asks for — deleting
    nothing is a success, not a 404 (the router answers 204 either way)."""
    owner = await make_user(db_session, "owner-idem")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    tournament_id, event_id = tournament.id, event.id

    result = await uncut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )

    assert result is None
    assert await _fixture_rows(db_session, event_id) == []


# ----- a non-owner is refused with a domain exception -----------------------


@pytest.mark.parametrize("verb", [cut_event_draw, uncut_event_draw])
async def test_a_non_owner_is_refused(
    db_session: AsyncSession,
    default_league: League,
    verb: object,
) -> None:
    owner = await make_user(db_session, "owner-guard")
    stranger = await make_user(db_session, "stranger-guard")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    tournament_id, event_id = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="guard")

    with pytest.raises(NotTournamentOwnerError):
        await verb(  # type: ignore[operator]  # parametrized over the two verbs
            db_session,
            tournament_id=tournament_id,
            event_id=event_id,
            actor=stranger,
        )

    # The ownership gate is asked before the draw's own state, so nothing changed.
    assert await _fixture_rows(db_session, event_id) == []


# ----- a missing tournament / event raises the 404-domain exception ---------


async def test_a_missing_tournament_raises_not_found(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    owner = await make_user(db_session, "owner-missing-t")

    with pytest.raises(TournamentNotFoundError):
        await cut_event_draw(
            db_session,
            tournament_id=uuid.uuid4(),
            event_id=uuid.uuid4(),
            actor=owner,
        )


async def test_a_missing_event_raises_event_not_found(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    owner = await make_user(db_session, "owner-missing-e")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id
    await db_session.refresh(owner)

    with pytest.raises(EventNotFoundError):
        await cut_event_draw(
            db_session,
            tournament_id=tournament_id,
            event_id=uuid.uuid4(),
            actor=owner,
        )


async def test_an_event_under_the_wrong_tournament_raises_event_not_found(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A right event id under the wrong tournament id is a miss, not a
    cross-tournament draw — the event is scoped by both ids."""
    owner = await make_user(db_session, "owner-cross")
    other_owner = await make_user(db_session, "owner-cross-other")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id
    other = await _make_tournament(db_session, owner=other_owner, league=default_league)
    event = await _make_event(db_session, other)
    event_id = event.id
    await db_session.refresh(owner)

    with pytest.raises(EventNotFoundError):
        await cut_event_draw(
            db_session,
            tournament_id=tournament_id,
            event_id=event_id,
            actor=owner,
        )
