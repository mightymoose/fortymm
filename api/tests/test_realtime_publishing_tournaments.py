"""Who gets hinted when a tournament moves.

``test_realtime_outbox`` proves the *mechanism* — staged, committed, published
once — and ``test_realtime_publishing`` proves the audience of a match
completion. This file proves the audience of the four **tournament** write paths,
which is the part a mechanism test cannot see: an implementation that hinted
everybody, or that hinted "everybody who ever entered", would pass every
mechanism test and fail only here.

The audience rule under test, throughout, is the one
``app.dashboard_tournaments.build_tournament_panels`` scopes the panel by —
players holding an **active entry** in the affected event. So every test below
names the players who must be hinted *and* the people who must not be: the
**withdrawn** entrant (the sharp one — it is what separates "holds an entry" from
"ever entered"), the **director**, who sees no panel unless they entered, and an
uninvolved signed-in **bystander**. Their counts are asserted to be exactly zero,
never merely smaller.

The writes are driven the way they really happen: the three request-path verbs
through their transport-neutral service functions on a raw session (the same way
``test_tournament_lifecycle`` / ``test_tournament_placement`` drive them), and the
solve apply through ``execute_solve`` with an injected sessionmaker — the
worker-shaped call path, which is the whole reason the publisher is synchronous.
The fan-out is observed at the broker (see :mod:`tests._realtime` for why never
over the socket, and how "zero" is made an assertion instead of a hopeful sleep).
"""

import uuid
from datetime import datetime
from decimal import Decimal

import fakeredis
import pytest
from rq import Queue
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import selectinload

from app import queue as queue_module
from app.models import (
    DrawType,
    EventFormat,
    League,
    Match,
    MatchSettings,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    ScheduleSolveTrigger,
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentEventDrawSettings,
    TournamentFixture,
    TournamentStatus,
    User,
)
from app.realtime import EventKind, RealtimeBroker
from app.schedule_solves import execute_solve, request_solve
from app.schemas.tournament import TournamentFixturePlacementUpdate
from app.tournament_advancement import on_match_completed
from app.tournament_draws import cut_draw
from app.tournament_event_stages import mint_stages
from app.tournament_lifecycle import transition_tournament
from app.tournament_placement import place_fixture
from app.tournament_queries import stage_ids_for_events
from tests._helpers import (
    event_groups,
    make_user,
    table_ids_of,
    venue_tables,
)
from tests._realtime import watch_hints

#: Far enough out that the solver never has to argue with the wall clock.
DATE = "2030-01-01"
START = datetime(2030, 1, 1, 10, 0)


def _name(stem: str) -> str:
    return f"{stem}-{uuid.uuid4().hex[:8]}"


@pytest.fixture
def recording_solver_queue(monkeypatch: pytest.MonkeyPatch) -> Queue:
    """An async (record-only) RQ queue replacing conftest's synchronous one, so a
    ``request_solve`` records its job instead of running it inline — the solve
    test drives ``execute_solve`` itself, post-commit, exactly as a worker
    would."""
    q = Queue(
        queue_module.SOLVER_QUEUE,
        connection=fakeredis.FakeStrictRedis(),
        is_async=True,
    )
    monkeypatch.setattr(queue_module, "get_queue", lambda: q)
    return q


class Field:
    """The cast of one seeded tournament: who is in it, and who is only nearby.

    Every test needs the same four roles — the active entrants, one entrant who
    withdrew, the director, and a signed-in stranger — so they are minted
    together and handed over as one value rather than as five positional
    returns.
    """

    def __init__(
        self,
        *,
        tournament: Tournament,
        event: TournamentEvent,
        players: list[User],
        withdrawn: User,
        director: User,
        bystander: User,
    ) -> None:
        self.tournament = tournament
        self.event = event
        self.players = players
        self.withdrawn = withdrawn
        self.director = director
        self.bystander = bystander

    @property
    def everyone(self) -> list[uuid.UUID]:
        """Every id a test watches: the entrants plus the three who must be hinted
        zero times."""
        return [
            *(player.id for player in self.players),
            self.withdrawn.id,
            self.director.id,
            self.bystander.id,
        ]

    def assert_only_entrants_hinted(
        self, hints: dict[uuid.UUID, list[EventKind]]
    ) -> None:
        """Every active entrant hinted exactly once; the withdrawn entrant, the
        director and the bystander exactly zero times."""
        for player in self.players:
            assert hints[player.id] == [EventKind.dashboard_changed], (
                f"{player.username} holds an active entry and must be hinted"
            )
        assert hints[self.withdrawn.id] == []
        assert hints[self.director.id] == []
        assert hints[self.bystander.id] == []


async def _seed_field(
    db: AsyncSession,
    league: League,
    *,
    entrants: int,
    status: TournamentStatus = TournamentStatus.published,
    tables: tuple[str, ...] = ("t1", "t2"),
) -> Field:
    """A tournament at ``status`` with one pooled, unrated, round-robin singles
    event; ``entrants`` players holding an active entry and one more who
    withdrew; plus a director who did not enter their own tournament and an
    unrelated signed-in bystander. Written straight to the database — none of
    this is about the create routes. The draw is left un-cut; callers cut it.
    """
    director = await make_user(db, _name("director"))
    catalogue = venue_tables(*((table.upper(), "Main") for table in tables))
    tournament = Tournament(
        name="Realtime Open",
        status=status,
        address={
            "venue": "Berkeley TT Club",
            "street": "1 Shattuck Ave",
            "city": "Berkeley",
            "region": "CA",
            "postal": "94704",
            "country": "USA",
            "latitude": 37.8703,
            "longitude": -122.2731,
        },
        tables=catalogue,
        league_id=league.id,
        created_by_user_id=director.id,
    )
    db.add(tournament)
    await db.flush()

    stages = mint_stages(DrawType.round_robin)
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Open Singles",
        format=EventFormat.singles,
        draw_settings=TournamentEventDrawSettings.for_draw_type(DrawType.round_robin),
        max_players=None,
        entry_fee=Decimal("0.00"),
        timezone="America/Chicago",
        slot={"date": DATE, "start": "09:00", "end": "17:00"},
        match_settings={"rated": False, "length_games": 3},
        stages=stages,
    )
    stages[0].groups = event_groups(
        [
            {
                "name": "Pool A",
                "slot": {"date": DATE, "start": "09:00", "end": "17:00"},
                "table_ids": [str(row.id) for row in catalogue],
            }
        ],
        event=event,
        tournament=tournament,
    )
    db.add(event)
    await db.flush()

    players = [await make_user(db, _name("player")) for _ in range(entrants)]
    for player in players:
        db.add(TournamentEntry(event_id=event.id, user_id=player.id))
    withdrawn = await make_user(db, _name("withdrawn"))
    db.add(
        TournamentEntry(
            event_id=event.id,
            user_id=withdrawn.id,
            status=TournamentEntryStatus.withdrawn,
        )
    )
    await db.commit()
    # ``TournamentEvent.pools`` is a VIEWONLY association through the event's stage now
    # (ADR 20260815) — populated on QUERY, not on construction. ``cut_draw`` is called
    # on ``field.event`` downstream and reads ``event.groups`` synchronously, so this
    # needs an explicit refresh first.
    await db.refresh(event, attribute_names=["groups"])

    return Field(
        tournament=tournament,
        event=event,
        players=players,
        withdrawn=withdrawn,
        director=director,
        bystander=await make_user(db, _name("bystander")),
    )


async def _fixtures_of(
    db: AsyncSession, event_id: uuid.UUID
) -> list[TournamentFixture]:
    return list(
        (
            await db.execute(
                select(TournamentFixture)
                .where(TournamentFixture.stage_id.in_(stage_ids_for_events([event_id])))
                .order_by(TournamentFixture.id)
            )
        )
        .scalars()
        .all()
    )


async def _go_live(db: AsyncSession, field: Field) -> None:
    """Cut the draw and take the tournament live — the state every
    already-running-tournament test starts from."""
    await cut_draw(db, field.event)
    await db.commit()
    await transition_tournament(
        db,
        tournament_id=field.tournament.id,
        actor=field.director,
        to=TournamentStatus.live,
    )


async def _load_match(db: AsyncSession, match_id: uuid.UUID) -> Match:
    """A match with its sides and their players eagerly loaded — the shape
    ``on_match_completed`` is always called with (``finalize_match`` runs under
    the read path's eager options)."""
    return (
        await db.execute(
            select(Match)
            .where(Match.id == match_id)
            .options(selectinload(Match.sides).selectinload(MatchSide.players))
        )
    ).scalar_one()


# --------------------------------------------------------------------------- #
# 1. A tournament goes live — the write that makes the panel appear at all.
# --------------------------------------------------------------------------- #


async def test_every_active_entrant_is_hinted_when_the_tournament_goes_live(
    db_session: AsyncSession,
    default_league: League,
    realtime_broker: RealtimeBroker,
) -> None:
    """Taking the tournament live is what makes the dashboard's tournament panel
    exist, so every player holding an active entry is told to refetch. A miss here
    is a player who never learns their tournament started."""
    field = await _seed_field(db_session, default_league, entrants=3)
    await cut_draw(db_session, field.event)
    await db_session.commit()

    async with watch_hints(realtime_broker, *field.everyone) as watch:
        moved = await transition_tournament(
            db_session,
            tournament_id=field.tournament.id,
            actor=field.director,
            to=TournamentStatus.live,
        )
        hints = await watch.collect()

    assert moved.status is TournamentStatus.live
    for player in field.players:
        assert hints[player.id] == [EventKind.dashboard_changed]


async def test_a_withdrawn_entrant_is_not_hinted_when_the_tournament_goes_live(
    db_session: AsyncSession,
    default_league: League,
    realtime_broker: RealtimeBroker,
) -> None:
    """The sharpest audience assertion in the file.

    A player who withdrew has no panel — ``build_tournament_panels`` filters them
    out — so hinting them is telling somebody to refetch a page that will not
    mention them. An implementation that queried "everyone who ever entered this
    event" passes every other test here and fails exactly this one. The director
    (who did not enter their own tournament) and an unrelated signed-in bystander
    are held to the same zero.
    """
    field = await _seed_field(db_session, default_league, entrants=2)
    await cut_draw(db_session, field.event)
    await db_session.commit()

    async with watch_hints(realtime_broker, *field.everyone) as watch:
        await transition_tournament(
            db_session,
            tournament_id=field.tournament.id,
            actor=field.director,
            to=TournamentStatus.live,
        )
        hints = await watch.collect()

    field.assert_only_entrants_hinted(hints)


# --------------------------------------------------------------------------- #
# 2. A draw advances — a completion moves standings, not just two players.
# --------------------------------------------------------------------------- #


async def test_a_draw_advancing_hints_the_whole_event_not_only_the_two_who_played(
    db_session: AsyncSession,
    default_league: League,
    realtime_broker: RealtimeBroker,
) -> None:
    """A round-robin standings table is projected from the whole pool, so a result
    can move a third player's position while they are sitting down. The
    participants' own hint (staged by ``finalize_match``) would never reach them —
    this one does, and the test proves it by naming the player who was *not* in the
    completed match."""
    field = await _seed_field(db_session, default_league, entrants=3)
    await _go_live(db_session, field)

    fixture = (await _fixtures_of(db_session, field.event.id))[0]
    assert fixture.match_id is not None, "go-live materialized the fixture"
    seated = {
        user_id
        for (user_id,) in (
            await db_session.execute(
                select(TournamentEntry.user_id).where(
                    TournamentEntry.id.in_([fixture.entry_a_id, fixture.entry_b_id])
                )
            )
        ).all()
    }
    (spectating_entrant,) = [p for p in field.players if p.id not in seated]

    match = await _load_match(db_session, fixture.match_id)
    for side in match.sides:
        side.won = side.side_number == 1
    match.status = MatchStatus.completed

    async with watch_hints(realtime_broker, *field.everyone) as watch:
        await on_match_completed(db_session, match)
        await db_session.commit()
        hints = await watch.collect()

    field.assert_only_entrants_hinted(hints)
    assert hints[spectating_entrant.id] == [EventKind.dashboard_changed], (
        "an entrant who did not play this match still had their standings moved"
    )


async def test_finishing_an_ordinary_ladder_match_hints_no_tournament_audience(
    db_session: AsyncSession,
    default_league: League,
    realtime_broker: RealtimeBroker,
) -> None:
    """The early return, asserted.

    ``on_match_completed`` runs on **every** completion, and almost none of them
    are tournament matches. A plain ladder match belongs to no fixture, so it has
    no event and therefore no tournament audience — this path must stage nothing
    at all (its participants are hinted by ``finalize_match``, which is not what
    is being driven here)."""
    one = await make_user(db_session, _name("ladder-one"))
    two = await make_user(db_session, _name("ladder-two"))
    match = Match(
        match_settings=MatchSettings(team_size=1, best_of=1, affects_rating=False),
        league_id=default_league.id,
        created_by_user_id=one.id,
        status=MatchStatus.completed,
    )
    for side_number, player in ((1, one), (2, two)):
        side = MatchSide(match=match, side_number=side_number, won=side_number == 1)
        side.players.append(MatchSidePlayer(match=match, user_id=player.id))
    db_session.add(match)
    await db_session.commit()

    loaded = await _load_match(db_session, match.id)
    async with watch_hints(realtime_broker, one.id, two.id) as watch:
        await on_match_completed(db_session, loaded)
        await db_session.commit()
        hints = await watch.collect()

    assert hints[one.id] == []
    assert hints[two.id] == []


# --------------------------------------------------------------------------- #
# 3a. A schedule solve lands — in the worker process, not the API process.
# --------------------------------------------------------------------------- #


async def test_applying_a_schedule_solve_hints_the_players_whose_times_moved(
    db_session: AsyncSession,
    engine: AsyncEngine,
    default_league: League,
    realtime_broker: RealtimeBroker,
    recording_solver_queue: Queue,
) -> None:
    """A solve that lands assigns a table and a start to every fixture, which is
    exactly what the panel shows — so its entrants are hinted.

    Driven through ``execute_solve`` with an injected sessionmaker, the way the
    repo tests background jobs: this code runs in the **RQ worker process**, which
    has no event loop to await a publish into. That it works at all through the
    same ``stage_event`` the request paths use is the point — one synchronous
    publisher serves both sides.
    """
    field = await _seed_field(db_session, default_league, entrants=2, tables=("t1",))
    await cut_draw(db_session, field.event)
    await db_session.commit()
    (the_table,) = await table_ids_of(db_session, field.tournament.id)
    (unplaced,) = await _fixtures_of(db_session, field.event.id)
    assert unplaced.scheduled_start is None and unplaced.table_id is None

    solve = await request_solve(
        db_session, field.tournament.id, ScheduleSolveTrigger.manual
    )
    assert solve is not None
    solve_id = solve.id
    # Committed and released before the job runs: the apply takes the tournament
    # row lock on its own session, which a still-open test transaction would
    # block on forever.
    await db_session.commit()

    job_sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with watch_hints(realtime_broker, *field.everyone) as watch:
        await execute_solve(job_sessions, solve_id)
        hints = await watch.collect()

    # Read back as columns, not as an ORM row: the job wrote on its own session,
    # so the test session's identity map still holds the un-placed instance.
    table_id, scheduled_start = (
        await db_session.execute(
            select(TournamentFixture.table_id, TournamentFixture.scheduled_start).where(
                TournamentFixture.id == unplaced.id
            )
        )
    ).one()
    assert table_id == the_table and scheduled_start is not None, (
        "the solve actually moved something — otherwise the hint proves nothing"
    )
    field.assert_only_entrants_hinted(hints)


# --------------------------------------------------------------------------- #
# 3b. A fixture is placed by hand — including the unpin nobody else covers.
# --------------------------------------------------------------------------- #


async def test_placing_a_fixture_hints_the_events_entrants(
    db_session: AsyncSession,
    default_league: League,
    realtime_broker: RealtimeBroker,
) -> None:
    """The director puts a fixture on a table at a time; both of those show on the
    entrants' panels, so both entrants refetch. The director, who is placing it,
    is not entered and is hinted zero times."""
    field = await _seed_field(db_session, default_league, entrants=2)
    await cut_draw(db_session, field.event)
    await db_session.commit()
    (fixture,) = await _fixtures_of(db_session, field.event.id)
    # The catalogue's real id: a placement names a real table now (ADR 20260801).
    (the_table, *_) = await table_ids_of(db_session, field.tournament.id)

    async with watch_hints(realtime_broker, *field.everyone) as watch:
        read = await place_fixture(
            db_session,
            tournament_id=field.tournament.id,
            fixture_id=fixture.id,
            actor=field.director,
            placement=TournamentFixturePlacementUpdate(
                table_id=the_table, scheduled_start=START
            ),
        )
        hints = await watch.collect()

    assert read.table_id == the_table
    field.assert_only_entrants_hinted(hints)


async def test_unpinning_a_fixture_still_hints_the_events_entrants(
    db_session: AsyncSession,
    default_league: League,
    realtime_broker: RealtimeBroker,
) -> None:
    """The case that would otherwise go untold.

    Clearing a placement fans out to **nobody** — there is no call to send when
    there is no longer a table or a time — so the notification path stays silent.
    But the players' panels just lost the start they were shown, which is a change
    they need to see. The hint is the only thing that tells them.
    """
    field = await _seed_field(db_session, default_league, entrants=2)
    await cut_draw(db_session, field.event)
    await db_session.commit()
    (fixture,) = await _fixtures_of(db_session, field.event.id)
    fixture_id = fixture.id
    (the_table, *_) = await table_ids_of(db_session, field.tournament.id)
    await place_fixture(
        db_session,
        tournament_id=field.tournament.id,
        fixture_id=fixture_id,
        actor=field.director,
        placement=TournamentFixturePlacementUpdate(
            table_id=the_table, scheduled_start=START
        ),
    )

    async with watch_hints(realtime_broker, *field.everyone) as watch:
        read = await place_fixture(
            db_session,
            tournament_id=field.tournament.id,
            fixture_id=fixture_id,
            actor=field.director,
            placement=TournamentFixturePlacementUpdate(
                table_id=None, scheduled_start=None
            ),
        )
        hints = await watch.collect()

    assert read.table_id is None and read.scheduled_start is None
    field.assert_only_entrants_hinted(hints)
