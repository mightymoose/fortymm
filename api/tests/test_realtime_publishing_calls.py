"""Who gets hinted when a table call is issued, moved, or cancelled.

The call's post-commit fan-out (``app.match_calls.enqueue_call_fanout``) is the
one write site in the realtime design that publishes **directly** instead of
staging on a session — its three callers all invoke it after their
``await db.commit()``, so there is no transaction left to hang a hint on. That
makes its audience the interesting property: the fan-out already carries one
``NotificationJob`` per entrant it told, and the hint has to ride exactly that
list rather than a re-derived "everyone in the tournament".

So every test below names the players who must be hinted **and** players who
must not be — an entrant whose own match is later that day, and a signed-in
user with no stake in the tournament at all. An implementation that broadcast to
the tournament, or to every connected user, passes nothing here.

Observed at the broker via :mod:`tests._realtime` (never over the socket — see
that module for why, and for how "zero hints" is made an assertion rather than a
hopeful sleep). The tick is driven through its real RQ entry point,
``run_pin_tick``; the director's moved/cancelled transitions are driven through
``apply_manual_placement`` + ``enqueue_call_fanout``, which is verbatim what
``app.tournament_placement.place_fixture`` does either side of its commit.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app import match_calls
from app.leagues import get_default_league
from app.match_calls import (
    apply_manual_placement,
    enqueue_call_fanout,
    notify_pin_repairs,
    run_pin_tick,
)
from app.models import (
    DrawType,
    EventFormat,
    Tournament,
    TournamentEntry,
    TournamentEvent,
    TournamentEventDrawSettings,
    TournamentFixture,
    TournamentStatus,
    User,
)
from app.realtime import EventKind, RealtimeBroker
from app.tournament_event_stages import mint_stages
from tests._helpers import (
    event_groups,
    make_user,
    venue_tables,
)
from tests._realtime import watch_hints

DATE = "2030-01-01"
VENUE_TZ_NAME = "America/Chicago"
VENUE_TZ = ZoneInfo(VENUE_TZ_NAME)
#: The reservation window's start, as a timezone-aware instant in the venue's frame —
#: the fixed "now" every clock in this module is frozen to.
BASE = datetime(2030, 1, 1, 9, 0, tzinfo=VENUE_TZ)
#: Far enough out that the second fixture is nowhere near the call-ahead window,
#: so "not hinted" is about the audience and not about a race with the clock.
LATER = BASE + timedelta(hours=4)


@dataclass(frozen=True)
class Staged:
    """A live tournament with two fixtures: one about to be called, one whose
    players are playing later that day (the in-tournament bystanders)."""

    tournament_id: uuid.UUID
    event_id: uuid.UUID
    called_fixture_id: uuid.UUID
    called: tuple[User, User]
    later: tuple[User, User]
    #: The called fixture's two entry rows, in the same order as ``called``.
    called_entry_ids: tuple[uuid.UUID, uuid.UUID]
    #: The venue catalogue's ids, in its order — server-minted UUIDs (ADR 20260801),
    #: which a fixture's ``table_id`` foreign-keys, so a test cannot spell one.
    table_ids: tuple[str, ...]

    @property
    def watched(self) -> tuple[uuid.UUID, ...]:
        return tuple(user.id for user in (*self.called, *self.later))

    def table(self, alias: str) -> str:
        """The id of the ``"t1"``-style positional alias this module talks in."""
        return self.table_ids[int(alias.removeprefix("t")) - 1]


async def _stage(
    db: AsyncSession, *, status: TournamentStatus = TournamentStatus.live
) -> Staged:
    """Two hand-built fixtures rather than a cut draw, so which pairing is due
    is a fact of the test and not of the draw generator's ordering."""
    owner = await make_user(db, f"director-{uuid.uuid4().hex[:8]}")
    league = await get_default_league(db)
    assert league is not None, "the autouse default_league fixture seeds this"

    tournament = Tournament(
        name="Called Open",
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
        tables=venue_tables(("T1", "Main"), ("T2", "Main")),
        league_id=league.id,
        created_by_user_id=owner.id,
    )
    db.add(tournament)
    await db.flush()
    table_ids = tuple(str(table.id) for table in tournament.tables)

    stages = mint_stages(DrawType.round_robin)
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Open Singles",
        format=EventFormat.singles,
        draw_settings=TournamentEventDrawSettings.for_draw_type(DrawType.round_robin),
        max_players=None,
        entry_fee=Decimal("0.00"),
        timezone=VENUE_TZ_NAME,
        slot={"date": DATE, "start": "09:00", "end": "17:00"},
        match_settings={"rated": False, "length_games": 3},
        stages=stages,
    )
    groups = event_groups(
        [
            {
                "name": "Reservation A",
                "slot": {"date": DATE, "start": "09:00", "end": "17:00"},
                "table_ids": ["t1", "t2"],
            }
        ],
        event=event,
        tournament=tournament,
    )
    stages[0].groups = groups
    db.add(event)
    await db.flush()

    async def _entrant(stem: str) -> tuple[User, TournamentEntry]:
        user = await make_user(db, f"{stem}-{uuid.uuid4().hex[:8]}")
        entry = TournamentEntry(event_id=event.id, user_id=user.id)
        db.add(entry)
        return user, entry

    called_a, entry_a = await _entrant("called-a")
    called_b, entry_b = await _entrant("called-b")
    later_a, entry_c = await _entrant("later-a")
    later_b, entry_d = await _entrant("later-b")
    await db.flush()

    called_fixture = TournamentFixture(
        stage_id=stages[0].id,
        group_id=groups[0].id,
        round=1,
        position=1,
        entry_a_id=entry_a.id,
        entry_b_id=entry_b.id,
    )
    later_fixture = TournamentFixture(
        stage_id=stages[0].id,
        group_id=groups[0].id,
        round=1,
        position=2,
        entry_a_id=entry_c.id,
        entry_b_id=entry_d.id,
        table_id=table_ids[1],
        scheduled_start=LATER,
    )
    db.add_all([called_fixture, later_fixture])
    await db.commit()

    return Staged(
        tournament_id=tournament.id,
        event_id=event.id,
        called_fixture_id=called_fixture.id,
        called=(called_a, called_b),
        later=(later_a, later_b),
        called_entry_ids=(entry_a.id, entry_b.id),
        table_ids=table_ids,
    )


async def _bystander(db: AsyncSession) -> User:
    """A signed-in user with no stake in this tournament at all."""
    return await make_user(db, f"bystander-{uuid.uuid4().hex[:8]}")


async def _called_fixture(db: AsyncSession, staged: Staged) -> TournamentFixture:
    fixture = await db.get(TournamentFixture, staged.called_fixture_id)
    assert fixture is not None
    return fixture


async def _place(
    db: AsyncSession,
    staged: Staged,
    *,
    table_id: str,
    start: datetime,
    pinned_at: datetime | None = None,
    notified: int = 0,
) -> None:
    """Write the called fixture's placement (and, optionally, an
    already-told pin) straight onto the row — the pre-state each transition
    below starts from."""
    fixture = await _called_fixture(db, staged)
    fixture.table_id = table_id
    fixture.scheduled_start = start
    fixture.pinned_at = pinned_at
    fixture.call_notified_count = notified
    await db.commit()


async def _tournament(db: AsyncSession, staged: Staged) -> Tournament:
    tournament = await db.get(Tournament, staged.tournament_id)
    assert tournament is not None
    return tournament


def _freeze(monkeypatch: pytest.MonkeyPatch, now: datetime) -> None:
    monkeypatch.setattr(match_calls, "_wall_now", lambda: now)


async def test_a_player_called_to_a_table_is_hinted_and_one_playing_later_is_not(
    db_session: AsyncSession,
    realtime_broker: RealtimeBroker,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The pin tick calls the imminent fixture: its two entrants each get one
    ``dashboard.changed``, and the two entrants of the 13:00 fixture — same
    tournament, same group, same event — get none, as does an uninvolved
    signed-in user."""
    staged = await _stage(db_session)
    bystander = await _bystander(db_session)
    await _place(
        db_session,
        staged,
        table_id=staged.table("t1"),
        start=BASE + timedelta(minutes=5),
    )
    _freeze(monkeypatch, BASE)

    async with watch_hints(realtime_broker, *staged.watched, bystander.id) as watch:
        run_pin_tick(str(staged.tournament_id))
        hints = await watch.collect()

    # Refresh just the fixture — the tick committed on its own engine, and an
    # ``expire_all`` here would expire the ``User`` rows too, turning the
    # assertions below into sync lazy loads on an async session.
    fixture = await _called_fixture(db_session, staged)
    await db_session.refresh(fixture)
    assert fixture.call_notified_count == 1, "the call really fired"

    called_a, called_b = staged.called
    later_a, later_b = staged.later
    assert hints[called_a.id] == [EventKind.dashboard_changed]
    assert hints[called_b.id] == [EventKind.dashboard_changed]
    assert hints[later_a.id] == []
    assert hints[later_b.id] == []
    assert hints[bystander.id] == []


async def test_a_call_that_fires_for_nobody_hints_nobody(
    db_session: AsyncSession,
    realtime_broker: RealtimeBroker,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The falsification for the test above: the same tick against a fixture
    whose start is hours away calls no one — so if any hint arrives, it came
    from something other than the call's recipient list."""
    staged = await _stage(db_session)
    bystander = await _bystander(db_session)
    await _place(db_session, staged, table_id=staged.table("t1"), start=LATER)
    _freeze(monkeypatch, BASE)

    async with watch_hints(realtime_broker, *staged.watched, bystander.id) as watch:
        run_pin_tick(str(staged.tournament_id))
        hints = await watch.collect()

    fixture = await _called_fixture(db_session, staged)
    await db_session.refresh(fixture)
    assert fixture.call_notified_count == 0, "nobody was called"
    assert all(received == [] for received in hints.values())


async def test_moving_a_called_player_to_another_table_hints_that_pair_only(
    db_session: AsyncSession,
    realtime_broker: RealtimeBroker,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The director re-places an already-called fixture (T1 → T2): both told
    entrants get the *moved* correction, and with it one hint each — their
    dashboards are showing a table that is no longer theirs. Nobody else's is.

    Driven the way ``app.tournament_placement.place_fixture`` drives it: the
    transition on the open transaction, commit, then the post-commit fan-out.
    """
    staged = await _stage(db_session)
    bystander = await _bystander(db_session)
    await _place(
        db_session,
        staged,
        table_id=staged.table("t1"),
        start=BASE + timedelta(minutes=5),
        pinned_at=BASE - timedelta(minutes=5),
        notified=1,  # already told → a re-place is a *moved* correction
    )
    _freeze(monkeypatch, BASE)

    async with watch_hints(realtime_broker, *staged.watched, bystander.id) as watch:
        fanout = await apply_manual_placement(
            db_session,
            await _tournament(db_session, staged),
            await _called_fixture(db_session, staged),
            table_id=staged.table("t2"),
            scheduled_start=BASE + timedelta(minutes=20),
            event_timezone=VENUE_TZ_NAME,
        )
        await db_session.commit()
        enqueue_call_fanout(fanout)
        hints = await watch.collect()

    called_a, called_b = staged.called
    later_a, later_b = staged.later
    assert {job.user_id for job in fanout} == {called_a.id, called_b.id}
    assert hints[called_a.id] == [EventKind.dashboard_changed]
    assert hints[called_b.id] == [EventKind.dashboard_changed]
    assert hints[later_a.id] == []
    assert hints[later_b.id] == []
    assert hints[bystander.id] == []


async def test_cancelling_a_call_hints_the_pair_who_were_told_to_go_there(
    db_session: AsyncSession,
    realtime_broker: RealtimeBroker,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The director un-places a called fixture: the pin is lifted, both told
    entrants get *match_call_cancelled* — and one hint each, because the table
    their dashboard is telling them to walk to no longer expects them."""
    staged = await _stage(db_session)
    bystander = await _bystander(db_session)
    await _place(
        db_session,
        staged,
        table_id=staged.table("t1"),
        start=BASE + timedelta(minutes=5),
        pinned_at=BASE - timedelta(minutes=5),
        notified=1,
    )
    _freeze(monkeypatch, BASE)

    async with watch_hints(realtime_broker, *staged.watched, bystander.id) as watch:
        fanout = await apply_manual_placement(
            db_session,
            await _tournament(db_session, staged),
            await _called_fixture(db_session, staged),
            table_id=None,
            scheduled_start=None,
            event_timezone=VENUE_TZ_NAME,
        )
        await db_session.commit()
        enqueue_call_fanout(fanout)
        hints = await watch.collect()

    called_a, called_b = staged.called
    later_a, later_b = staged.later
    fixture = await _called_fixture(db_session, staged)
    assert fixture.pinned_at is None, "the promise was withdrawn"
    assert {job.user_id for job in fanout} == {called_a.id, called_b.id}
    assert hints[called_a.id] == [EventKind.dashboard_changed]
    assert hints[called_b.id] == [EventKind.dashboard_changed]
    assert hints[later_a.id] == []
    assert hints[later_b.id] == []
    assert hints[bystander.id] == []


async def test_a_withdrawal_cancellation_hints_only_the_player_left_standing(
    db_session: AsyncSession,
    realtime_broker: RealtimeBroker,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The sharpest audience test there is: a broken-pin repair caused by one
    entrant withdrawing tells the *remaining* entrant only (the withdrawer asked
    to leave — their own action was their feedback). So exactly one of the two
    called players is hinted, and it is the one still expecting to play.

    A "hint everyone on the fixture" shortcut passes every other test in this
    file and fails this one.
    """
    staged = await _stage(db_session)
    bystander = await _bystander(db_session)
    await _place(
        db_session,
        staged,
        table_id=staged.table("t1"),
        start=BASE + timedelta(minutes=5),
        pinned_at=BASE - timedelta(minutes=5),
        notified=1,
    )
    _freeze(monkeypatch, BASE)

    remaining, withdrew = staged.called
    _, withdrew_entry_id = staged.called_entry_ids

    async with watch_hints(realtime_broker, *staged.watched, bystander.id) as watch:
        fixture = await _called_fixture(db_session, staged)
        # The repair the guarded apply would have written: the pin is void.
        fixture.table_id = None
        fixture.scheduled_start = None
        fixture.pinned_at = None
        fanout = await notify_pin_repairs(
            db_session,
            await _tournament(db_session, staged),
            cancelled=[fixture],
            withdrawn_entry_ids={withdrew_entry_id},
        )
        await db_session.commit()
        enqueue_call_fanout(fanout)
        hints = await watch.collect()

    later_a, later_b = staged.later
    assert {job.user_id for job in fanout} == {remaining.id}
    assert hints[remaining.id] == [EventKind.dashboard_changed]
    assert hints[withdrew.id] == []
    assert hints[later_a.id] == []
    assert hints[later_b.id] == []
    assert hints[bystander.id] == []


async def test_a_silent_pre_live_placement_hints_nobody(
    db_session: AsyncSession,
    realtime_broker: RealtimeBroker,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Pre-live, a placement is an estimate of a day still being planned: it
    tells nobody, so it must hint nobody either — a director dragging a
    published tournament's board around must not light up four dashboards."""
    staged = await _stage(db_session, status=TournamentStatus.published)
    bystander = await _bystander(db_session)
    _freeze(monkeypatch, BASE)

    async with watch_hints(realtime_broker, *staged.watched, bystander.id) as watch:
        fanout = await apply_manual_placement(
            db_session,
            await _tournament(db_session, staged),
            await _called_fixture(db_session, staged),
            table_id=staged.table("t1"),
            scheduled_start=BASE + timedelta(minutes=5),
            event_timezone=VENUE_TZ_NAME,
        )
        await db_session.commit()
        enqueue_call_fanout(fanout)
        hints = await watch.collect()

    fixture = await _called_fixture(db_session, staged)
    assert fixture.pinned_at == BASE, "it pinned — silently"
    assert fanout == []
    assert all(received == [] for received in hints.values())
