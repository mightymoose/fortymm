"""Direct tests for the ORM→domain projection ``app.tournament_draws.fixture_state``.

The one bridge from a persisted ``TournamentFixture`` row to the pure
:class:`~app.draws.FixtureState` every strategy's ``advance()`` reads. Everything else
in the draw domain is exercised through it (go-live materialization, the completion
seam), which is exactly why it is worth pinning on its own: those callers would still
pass with the two sides of a scoreline transposed, because a mirrored 1–3 is as
plausible-looking a result as a 3–1.

The game counts are fed in the way a caller gets them — ``fixtures_by_event`` →
``completed_match_ids`` → ``game_counts_by_match``, the shipped chain — rather than
hand-built, so "an in-progress match's games do not reach a strategy" is a fact about
the real filter and not about a literal this file wrote.
"""

import uuid
from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession

from app.draws import FixtureGames
from app.models import (
    League,
    Match,
    MatchGame,
    MatchGameScore,
    MatchSettings,
    MatchStatus,
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentEventDrawSettings,
    TournamentEventStageGroup,
    TournamentFixture,
    TournamentStatus,
    User,
)
from app.models.tournament import DrawType, EventFormat
from app.tournament_draws import draw_config, fixture_state, pool_order
from app.tournament_event_stages import mint_stages
from app.tournament_queries import (
    completed_match_ids,
    fixtures_by_event,
    game_counts_by_match,
)
from tests._helpers import (
    event_pools,
    make_user,
    venue_tables,
)

POOL_A: dict[str, object] = {
    "name": "Pool A",
    "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
    "table_ids": ["t1"],
}


async def _make_event(
    db: AsyncSession, *, owner: User, league: League
) -> tuple[TournamentEvent, uuid.UUID, uuid.UUID]:
    """Returns the event, its (only) pool's id and its (only) stage's id.

    The ids are handed back explicitly rather than read off ``event.groups`` /
    ``event.stages`` afterward: both are VIEWONLY / not-eager now (ADR 20260815 — a
    pool's real parent is its stage, and ``TournamentEvent.stages`` is deliberately not
    eager), so a fresh attribute access on either in this async context would either
    raise (a lazy load) or require a second query. Capturing the ids from the very
    objects this function already built and flushed costs nothing extra.
    """
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
            "latitude": 37.8703,
            "longitude": -122.2731,
        },
        tables=venue_tables(("Table 1", "A")),
        league_id=league.id,
        created_by_user_id=owner.id,
        status=TournamentStatus.live,
    )
    db.add(tournament)
    await db.flush()
    stages = mint_stages(DrawType.round_robin)
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Open Singles",
        format=EventFormat.singles,
        draw_settings=TournamentEventDrawSettings.for_draw_type(DrawType.round_robin),
        max_players=64,
        entry_fee=Decimal("45"),
        timezone="America/Chicago",
        slot={"date": "2026-06-13", "start": "09:00", "end": "18:00"},
        match_settings={"rated": True, "length_games": 5},
        predicates=[],
        stages=stages,
    )
    pools = event_pools([POOL_A], event=event, tournament=tournament)
    stages[0].groups = pools
    db.add(event)
    await db.flush()
    return event, pools[0].id, stages[0].id


async def _entry(db: AsyncSession, event: TournamentEvent, username: str) -> uuid.UUID:
    entry = TournamentEntry(
        event_id=event.id,
        user_id=(await make_user(db, username)).id,
        status=TournamentEntryStatus.entered,
    )
    db.add(entry)
    await db.flush()
    return entry.id


async def _match(
    db: AsyncSession,
    *,
    owner: User,
    league: League,
    status: MatchStatus,
    games: list[tuple[int, int]],
) -> uuid.UUID:
    """A match with ``games`` scored on its board — ``(side_1_points, side_2_points)``
    per game — in ``status``.

    The board is populated whatever the status, because a live match genuinely has one:
    that is what makes the in-progress case below a real exclusion rather than an empty
    query.
    """
    match = Match(
        match_settings=MatchSettings(team_size=1, best_of=5, affects_rating=True),
        league_id=league.id,
        created_by_user_id=owner.id,
        status=status,
    )
    db.add(match)
    await db.flush()
    for number, (side_1_points, side_2_points) in enumerate(games, start=1):
        game = MatchGame(match_id=match.id, game_number=number)
        db.add(game)
        await db.flush()
        db.add(
            MatchGameScore(
                match_game_id=game.id,
                side_1_points=side_1_points,
                side_2_points=side_2_points,
            )
        )
    await db.flush()
    return match.id


async def _fixture(
    db: AsyncSession,
    *,
    stage_id: uuid.UUID,
    pool_id: uuid.UUID,
    position: int,
    entry_a_id: uuid.UUID,
    entry_b_id: uuid.UUID,
    match_id: uuid.UUID | None,
) -> TournamentFixture:
    fixture = TournamentFixture(
        stage_id=stage_id,
        pool_id=pool_id,
        round=1,
        position=position,
        entry_a_id=entry_a_id,
        entry_b_id=entry_b_id,
        match_id=match_id,
    )
    db.add(fixture)
    await db.flush()
    return fixture


async def _game_counts(
    db: AsyncSession, event_id: uuid.UUID
) -> dict[uuid.UUID, tuple[int, int]]:
    """The games each side won, for this event's **completed** matches only — built
    through the shipped loader chain a caller of ``fixture_state`` uses."""
    return await game_counts_by_match(
        db, completed_match_ids(await fixtures_by_event(db, [event_id]))
    )


async def test_a_completed_match_projects_the_games_each_side_won(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A decided fixture carries its per-side game counts, and they are **not**
    symmetric: side 1 (``entry_a``) took 3, side 2 (``entry_b``) took 1.

    Both orientations are asserted — one fixture won 3–1 by ``entry_a``, its mirror won
    3–1 by ``entry_b`` — so neither transposing the two sides nor normalizing the
    winner's count into the first slot can survive.
    """
    owner = await make_user(db_session, "proj-owner")
    event, pool_id, stage_id = await _make_event(
        db_session, owner=owner, league=default_league
    )
    a = await _entry(db_session, event, "proj-a")
    b = await _entry(db_session, event, "proj-b")
    c = await _entry(db_session, event, "proj-c")
    d = await _entry(db_session, event, "proj-d")
    a_won = await _fixture(
        db_session,
        stage_id=stage_id,
        pool_id=pool_id,
        position=1,
        entry_a_id=a,
        entry_b_id=b,
        match_id=await _match(
            db_session,
            owner=owner,
            league=default_league,
            status=MatchStatus.completed,
            games=[(11, 5), (11, 7), (6, 11), (11, 9)],
        ),
    )
    b_won = await _fixture(
        db_session,
        stage_id=stage_id,
        pool_id=pool_id,
        position=2,
        entry_a_id=c,
        entry_b_id=d,
        match_id=await _match(
            db_session,
            owner=owner,
            league=default_league,
            status=MatchStatus.completed,
            games=[(5, 11), (7, 11), (11, 6), (9, 11)],
        ),
    )
    await db_session.commit()

    game_counts = await _game_counts(db_session, event.id)

    assert fixture_state(a_won, game_counts).games == FixtureGames(
        entry_a_games=3, entry_b_games=1
    ), "side 1's games are entry A's — 3 of them — and side 2's are entry B's"
    assert fixture_state(b_won, game_counts).games == FixtureGames(
        entry_a_games=1, entry_b_games=3
    ), "the mirror image: the winner's count does not move to the front"


async def test_a_fixture_with_no_match_projects_no_games(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """An unplayed fixture's games are **absent**, not ``0–0``. A 0 is a real count (a
    walkover reads 0 for the loser), so the two must stay tellable apart."""
    owner = await make_user(db_session, "proj-nomatch-owner")
    event, pool_id, stage_id = await _make_event(
        db_session, owner=owner, league=default_league
    )
    a = await _entry(db_session, event, "proj-nomatch-a")
    b = await _entry(db_session, event, "proj-nomatch-b")
    unplayed = await _fixture(
        db_session,
        stage_id=stage_id,
        pool_id=pool_id,
        position=1,
        entry_a_id=a,
        entry_b_id=b,
        match_id=None,
    )
    await db_session.commit()

    assert (
        fixture_state(unplayed, await _game_counts(db_session, event.id)).games is None
    )
    # And with no counts loaded at all — the default every caller that does not tabulate
    # takes — it is the same absence.
    assert fixture_state(unplayed).games is None


async def test_a_match_that_has_not_completed_projects_no_games(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A live fixture's part-scored board is not a result: its match has two scored
    games in the database, and none of them reach the projection.

    This is the case a hand-built count map cannot exercise — the games exist, and it is
    ``completed_match_ids``' status filter that keeps them out."""
    owner = await make_user(db_session, "proj-live-owner")
    event, pool_id, stage_id = await _make_event(
        db_session, owner=owner, league=default_league
    )
    a = await _entry(db_session, event, "proj-live-a")
    b = await _entry(db_session, event, "proj-live-b")
    in_play = await _fixture(
        db_session,
        stage_id=stage_id,
        pool_id=pool_id,
        position=1,
        entry_a_id=a,
        entry_b_id=b,
        match_id=await _match(
            db_session,
            owner=owner,
            league=default_league,
            status=MatchStatus.in_progress,
            games=[(11, 5), (11, 7)],
        ),
    )
    await db_session.commit()

    state = fixture_state(in_play, await _game_counts(db_session, event.id))

    assert state.match_id is not None, "the fixture HAS materialized into a match"
    assert state.games is None, "an in-progress board is not a result"


# --- the event's pool ORDER --------------------------------------------------------
#
# ``draw_config`` seeds the snake against it, ``pool_order`` is what a persisted
# fixture's ``pool_position`` is resolved through, and both read it off
# ``Pool.position`` (ADR 20260801) rather than off the pool id. The ids below are
# server-minted uuids, whose order is *random* — which is exactly why the position had
# to become a column: a sort that fell back to the id deals a different draw every time.

POOL_COUNT = 10


def _pools() -> list[TournamentEventStageGroup]:
    """Ten group rows in the director's order — each carrying the ``position`` of its
    index, which is what the write boundary stamps, and a minted id, with its
    reservation mapped alongside.

    ``event_pools`` requires an ``event`` (a group's real parent is its stage, ADR
    20260815, and a reservation's is the event), but every pool below has empty
    ``table_ids``, so the event is never actually read — a throwaway, never-persisted
    :class:`TournamentEvent` satisfies the signature with nothing behind it to be wrong.
    """
    return event_pools(
        [
            {
                "name": f"Pool {index + 1}",
                "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
                "table_ids": [],
            }
            for index in range(POOL_COUNT)
        ],
        event=TournamentEvent(),
    )


def test_draw_config_orders_the_pools_by_position_not_by_id() -> None:
    """``DrawConfig.pool_ids`` is the sequence the snake deals against, so its order is
    the draw's seeding — get it wrong and the draw still cuts, still looks like a draw,
    and seats the wrong people together.

    The pools are stored in *reverse* positional order here, so the array order and the
    positions disagree: what comes back has to be the positions' order, which is neither
    the array's nor the ids'.
    """
    stored = _pools()
    event = TournamentEvent(groups=list(reversed(stored)))

    assert draw_config(event).pool_ids == tuple(pool.id for pool in stored)


# There is deliberately no "pools stored before ``position`` existed keep their array
# order" test any more. That case was about a JSONB object with no ``position`` key;
# pools are rows with a ``NOT NULL position`` (ADR 20260801), so the state it described
# is not one the database will hold — and there is no pre-deploy data to describe.


def test_pool_order_ranks_every_pool_id_by_the_events_order() -> None:
    """The lookup the fixture projection resolves through: id → 0-based place, the same
    sequence ``draw_config`` hands the snake, so a draw is advanced in the order it was
    cut in."""
    stored = _pools()
    event = TournamentEvent(groups=list(reversed(stored)))

    assert pool_order(event) == {pool.id: index for index, pool in enumerate(stored)}


def test_fixture_state_projects_its_pools_place_in_the_event_order() -> None:
    """The bridge fills ``pool_position`` from the passed lookup — the fact
    ``ready_fixtures`` groups a plan by. The **tenth** pool is the discriminating case:
    it is last in the director's order and, under random uuid ids, nowhere in particular
    in theirs."""
    stored = _pools()
    event = TournamentEvent(groups=stored)
    fixture = TournamentFixture(
        id=uuid.uuid4(),
        stage_id=uuid.uuid4(),
        pool_id=stored[9].id,
        round=1,
        position=1,
    )

    assert (
        fixture_state(fixture, None, frozenset(), pool_order(event)).pool_position == 9
    )


def test_fixture_state_projects_no_pool_position_when_there_is_no_pool() -> None:
    """An un-pooled fixture (single-elim, or an rr-then-ko draw's KO stage) is in no
    pool, so there is no place to project — ``None``, whatever lookup is passed. And a
    caller that passes no lookup at all gets ``None`` for a *pooled* fixture too: the
    order was not resolved, which is a different thing from position zero."""
    stored = _pools()
    event = TournamentEvent(groups=stored)
    un_pooled = TournamentFixture(
        id=uuid.uuid4(), stage_id=uuid.uuid4(), pool_id=None, round=1, position=1
    )
    pooled = TournamentFixture(
        id=uuid.uuid4(),
        stage_id=uuid.uuid4(),
        pool_id=stored[0].id,
        round=1,
        position=1,
    )

    assert (
        fixture_state(un_pooled, None, frozenset(), pool_order(event)).pool_position
        is None
    )
    assert fixture_state(pooled).pool_position is None
